import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Shared SSRF-hardened URL validation for the media proxies.
//
// Threat model: `url`/`src` params are attacker-controllable on public
// deployments. We block private/loopback/link-local targets at three layers:
//   1. literal host checks (incl. IPv6 forms, trailing dots, hex/octal IPv4 —
//      the latter two are already canonicalized by WHATWG URL parsing),
//   2. DNS resolution of hostnames and a check on every resolved address,
//   3. re-validation of every redirect hop (safeFetch uses redirect:"manual").
// Residual risk: DNS rebinding between our lookup and the socket connect
// (TOCTOU). Closing that requires pinning the IP at connect time, which breaks
// TLS/SNI for CDNs — accepted for this app's exposure.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const DNS_CACHE_TTL = 60_000;
const DNS_CACHE_MAX = 500;

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIPv6(raw: string): boolean {
  const h = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::" || h === "::0") return true;
  // IPv4-mapped / IPv4-compatible with a dotted tail: ::ffff:127.0.0.1
  const dotted = h.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isBlockedIPv4(dotted[1]);
  // Hex tail forms: ::ffff:7f00:1 (127.0.0.1) and ::7f00:1
  const hexTail = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexTail) {
    const hi = parseInt(hexTail[1], 16);
    const lo = parseInt(hexTail[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(h.split(":").find((s) => s !== "") ?? "0", 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

// Hostname → safe-to-resolve cache so per-segment proxy re-entry stays cheap.
// Negative results are cached too (prevents DNS-hammering via garbage hosts).
const dnsCache = new Map<string, { safe: boolean; ts: number }>();

async function resolvesPublic(hostname: string): Promise<boolean> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && now - cached.ts < DNS_CACHE_TTL) return cached.safe;

  let safe = false;
  try {
    const addrs = await lookup(hostname, { all: true, verbatim: true });
    safe =
      addrs.length > 0 &&
      addrs.every((a) => (a.family === 4 ? !isBlockedIPv4(a.address) : !isBlockedIPv6(a.address)));
  } catch {
    // Unresolvable — fetch would fail anyway; do not open the door on DNS blips
    // resolving differently a moment later.
    safe = false;
  }

  if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
  dnsCache.set(hostname, { safe, ts: now });
  return safe;
}

export async function isSafeUrl(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  // WHATWG URL already canonicalizes decimal/octal/hex IPv4 (0x7f.0.0.1,
  // 2130706433, 127.1 → 127.0.0.1) and lowercases/normalizes IPv6.
  const bare = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(bare);
  if (family === 4) return !isBlockedIPv4(bare);
  if (family === 6) return !isBlockedIPv6(bare);

  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local")) return false;
  // Single-label names are internal short names (intranet, metadata, …); every
  // real CDN hostname contains a dot.
  if (!bare.includes(".")) return false;
  return resolvesPublic(bare);
}

export function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

// CR/LF would make undici's Headers constructor throw (a 502 where we want the
// request to proceed with a cleaned value).
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export interface SafeFetchOptions {
  /** Abort if response *headers* have not arrived yet. Cleared before the body
   * streams, so long video downloads are never cut off. */
  headersTimeoutMs?: number;
  maxRedirects?: number;
}

/** fetch() with per-hop SSRF re-validation and a headers-only timeout. */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 15_000;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await isSafeUrl(current))) {
      let host = "?";
      try {
        host = new URL(current).hostname;
      } catch { /* malformed — keep "?" */ }
      throw new Error(`blocked upstream url (${host})`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), headersTimeoutMs);
    const signal =
      init.signal && typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
        ? AbortSignal.any([init.signal, ctrl.signal])
        : (init.signal ?? ctrl.signal);

    let res: Response;
    try {
      res = await fetch(current, { ...init, redirect: "manual", signal });
    } finally {
      // Microtasks run before timers, so this always wins the race — the abort
      // never fires once headers are in, leaving the body stream unrestricted.
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) return res;
      res.body?.cancel().catch(() => {});
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new Error("malformed redirect location");
      }
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/** Read a text body with a hard byte cap and wall-clock deadline. */
export async function readTextCapped(res: Response, maxBytes: number, deadlineMs: number): Promise<string> {
  return (await readCapped(res, maxBytes, deadlineMs)).toString("utf-8");
}

/** Read a binary body with a hard byte cap and wall-clock deadline. */
export async function readCapped(res: Response, maxBytes: number, deadlineMs: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`upstream body too large (${declared} bytes)`);
  }

  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const endAt = Date.now() + deadlineMs;
  try {
    for (;;) {
      const remain = endAt - Date.now();
      if (remain <= 0) throw new Error("upstream body timed out");

      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("upstream body timed out")), remain);
          reader.read().then(resolve, reject);
        });
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;

      total += result.value.byteLength;
      if (total > maxBytes) throw new Error(`upstream body too large (>${maxBytes} bytes)`);
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
