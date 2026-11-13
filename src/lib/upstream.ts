// Shared helpers for upstream domain rotation.
//
// Every anime/movie provider in this app scrapes an unofficial mirror whose
// domain dies every few weeks (DMCA seizure, Cloudflare abuse ban, Vercel
// takedown). Hardcoding a single domain means one dead DNS record = 404s
// across the whole app until someone edits the source. These helpers make
// every base URL env-overridable with automatic fallback to the next domain.

/** Read a comma-separated URL/host list env var, falling back to defaults. */
export function envList(name: string, defaults: string[]): string[] {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return [...defaults];
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, ""));
  return out.length > 0 ? out : [...defaults];
}

/** Read a single string env var with a default. */
export function envStr(name: string, def: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw || def;
}

/** Strip trailing slashes so `${base}/path` never becomes `//path`. */
export function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Parse `https://host|Label, https://other` into { host, label } pairs. */
export function parseMirrorList(
  entries: string[],
  defaultLabels: Map<string, string>
): { host: string; label: string }[] {
  return entries.map((entry) => {
    const [hostRaw, ...labelParts] = entry.split("|");
    const host = normalizeBase(hostRaw.trim());
    const label = labelParts.join("|").trim();
    if (label) return { host, label };
    const known = defaultLabels.get(host);
    if (known) return { host, label: known };
    try {
      return { host, label: `Anikoto ${new URL(host).hostname}` };
    } catch {
      return { host, label: host };
    }
  });
}
