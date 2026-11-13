import axios from "axios";
import * as cheerio from "cheerio";
import { scoreTitle, MIN_SCORE } from "./title-score";
import { isSafeUrl } from "./safe-url";
import { envList, normalizeBase, parseMirrorList } from "./upstream";
import { extractPlayerSources, type MegaExtract } from "./megaplay";

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": AGENT, "X-Requested-With": "XMLHttpRequest" };

// Each mirror is exposed as its own player so users can fail over between them.
// Override/extend without editing source:
//   ANIKOTO_MIRRORS=https://anikoto.cz|Anikoto CZ,https://new-mirror.to|Anikoto NEW
const DEFAULT_MIRRORS: { host: string; label: string }[] = [
  { host: "https://anikoto.cz", label: "Anikoto CZ" },
  { host: "https://anikototv.to", label: "Anikoto" },
  { host: "https://anikoto.me", label: "Anikoto ME" },
  { host: "https://anikoto.net", label: "Anikoto NET" },
];

function getMirrors(): { host: string; label: string }[] {
  const entries = envList(
    "ANIKOTO_MIRRORS",
    DEFAULT_MIRRORS.map((m) => `${m.host}|${m.label}`)
  );
  const known = new Map(DEFAULT_MIRRORS.map((m) => [normalizeBase(m.host), m.label]));
  return parseMirrorList(entries, known);
}

export interface StreamSubtitle {
  label: string;
  url: string;
  srclang?: string;
}

/** Playback window in seconds (intro/outro), as supplied by a provider. */
export interface SkipWindow {
  start: number;
  end: number;
}

export interface StreamResult {
  embedUrl: string;
  serverName: string;
  title: string;
  // Direct HLS stream + subtitle tracks (when the upstream exposes them).
  // Rendered by VideoPlayer; the embed is kept as a fallback.
  streamUrl?: string;
  subtitles?: StreamSubtitle[];
  // Upstream-supplied intro/outro windows — exact for the streamed file, so
  // they take priority over AniSkip's crowd-sourced times.
  intro?: SkipWindow;
  outro?: SkipWindow;
  // Set by stream extraction: the honest player name ("Megaplay"/"Direct").
  // Upstream server labels are unreliable — Anikoto lists its Megaplay player
  // as "Vidstream-1" — so UI names prefer this when present.
  playerName?: string;
  // True when this provider genuinely serves the requested audio variant.
  // False means the source is sub-only and must be hidden from dub requests.
  dubCapable?: boolean;
}

const cache = new Map<string, { results: StreamResult[]; ts: number }>();
const CACHE_TTL = 1800_000;
const CACHE_MAX = 500;

// Sweep expired entries on write so a long-running server cannot accumulate
// one entry per (title, ep, mode) forever.
function cacheSet(key: string, results: StreamResult[]) {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts >= CACHE_TTL) cache.delete(k);
    }
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(key, { results, ts: Date.now() });
}

// Pre-extraction source: everything StreamResult carries plus the player page
// HTML, so stream extraction can run once per unique player (after the dedupe
// below) instead of once per mirror. `label` is the mirror name, `serverLabel`
// the upstream player label — which is often a lie ("Vidstream-1" for a
// Megaplay player), so the final name prefers the extracted playerName.
interface AnikotoSource {
  embedUrl: string;
  label: string;
  serverLabel: string;
  title: string;
  dubCapable: boolean;
  pageHtml: string;
}

async function resolveFromMirror(
  mirror: { host: string; label: string },
  title: string,
  ep: string,
  mode: "sub" | "dub"
): Promise<AnikotoSource> {
  // 1. Search — WordPress returns both series pages and individual episode
  //    permalinks, so rank candidates instead of taking the first hit.
  const searchRes = await axios.get(`${mirror.host}/search`, {
    params: { keyword: title },
    headers: HEADERS,
    timeout: 8000,
  });
  const $ = cheerio.load(searchRes.data);

  const seen = new Set<string>();
  const candidates: { url: string; score: number }[] = [];
  const consider = (href: string | undefined, name: string) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    const score = scoreTitle(title, name);
    if (score >= MIN_SCORE) candidates.push({ url: href, score });
  };

  // Each result is an .item holding a poster link plus a `a.name` title link.
  const items = $("#list-items .item");
  if (items.length > 0) {
    items.each((_, el) => {
      const item = $(el);
      const nameLink = item.find("a.name, a.d-title").first();
      const href = nameLink.attr("href") || item.find("a[href]").first().attr("href");
      const name = nameLink.text().trim() || item.find("img").attr("alt") || "";
      consider(href, name);
    });
  } else {
    $(".ani a[href], a.ani[href]").each((_, el) => {
      const node = $(el);
      consider(node.attr("href"), node.attr("title") || node.find("img").attr("alt") || node.text().trim());
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) throw new Error(`"${title}" not found on ${mirror.label}`);

  let lastError = "No matching series";
  // Walk ranked candidates; a show's seasons/spinoffs often split the episode
  // numbers, so the top title match may not carry the episode we need.
  for (const candidate of candidates.slice(0, 4)) {
    try {
      return await resolveEpisode(mirror, candidate.url, title, ep, mode);
    } catch (e) {
      lastError = String(e).substring(0, 90);
      // score 1000 = exact title match. Walking past it would hand back a
      // spin-off/season as if it were the requested show — fail instead.
      if (candidate.score >= 1000) break;
    }
  }
  throw new Error(lastError);
}

async function resolveEpisode(
  mirror: { host: string; label: string },
  watchUrl: string,
  title: string,
  ep: string,
  mode: "sub" | "dub"
): Promise<AnikotoSource> {
  const absolute = watchUrl.startsWith("http") ? watchUrl : `${mirror.host}${watchUrl}`;
  // watchUrl comes from upstream search-result hrefs — a poisoned result could
  // point anywhere (internal network). Same gate as the media proxies.
  if (watchUrl.startsWith("http") && !(await isSafeUrl(watchUrl))) {
    throw new Error("Blocked unsafe watch URL");
  }

  // 2. Watch page -> data-id
  const watchRes = await axios.get(absolute, { headers: HEADERS, timeout: 8000 });
  const dataId = watchRes.data.match(/data-id="(\d+)"/)?.[1];
  if (!dataId) throw new Error("Could not resolve anime ID");

  // 3. Episode list -> target episode's server payload
  const epRes = await axios.get(`${mirror.host}/ajax/episode/list/${dataId}`, { headers: HEADERS, timeout: 8000 });
  const $ep = cheerio.load(epRes.data?.result ?? "");
  const target = $ep(`a[data-num="${ep}"]`).first();
  // data-sub / data-dub tell us up front whether this episode has the requested audio.
  if (mode === "dub" && target.attr("data-dub") === "0") {
    throw new Error(`Episode ${ep} has no dub on ${mirror.label}`);
  }
  if (mode === "sub" && target.attr("data-sub") === "0") {
    throw new Error(`Episode ${ep} has no sub on ${mirror.label}`);
  }
  const epDataIds = target.attr("data-ids");
  if (!epDataIds) throw new Error(`Episode ${ep} not found`);

  // 4. Server list, restricted to the requested audio type
  const srvRes = await axios.get(`${mirror.host}/ajax/server/list?servers=${epDataIds}`, { headers: HEADERS, timeout: 8000 });
  const $srv = cheerio.load(srvRes.data?.result ?? "");

  // Servers live under div.type[data-type="sub"|"dub"]. When the response declares
  // types we must never fall back to the other variant — that silently played
  // Japanese audio while the UI said DUB.
  const typed = $srv(`div.type[data-type="${mode}"] li[data-link-id]`).toArray();
  let serverNodes = typed;
  // Whether the audio variant was proven: only a data-type-scoped match proves
  // it. The untyped fallback (response carries no type info at all) does not.
  const verified = typed.length > 0;
  if (serverNodes.length === 0 && $srv("div.type[data-type]").length === 0) {
    serverNodes = $srv("li[data-link-id]").toArray();
  }
  if (serverNodes.length === 0) throw new Error(`No ${mode} servers for episode ${ep}`);

  // 5. Try each server until one resolves to a live player page
  let lastError = "All servers failed";
  for (const el of serverNodes) {
    const node = $srv(el);
    const linkId = node.attr("data-link-id");
    const name = node.text().trim();
    if (!linkId) continue;
    try {
      const embedRes = await axios.get(`${mirror.host}/ajax/server?get=${linkId}`, { headers: HEADERS, timeout: 8000 });
      const embedUrl = embedRes.data?.result?.url;
      if (!embedUrl || !String(embedUrl).startsWith("http")) continue;
      // embedUrl is built from upstream-controlled data — SSRF gate before fetch.
      if (!(await isSafeUrl(embedUrl))) continue;

      // The player page itself is the real availability check — upstream embeds
      // answer 200 with an "Error Code:" body when a source has been taken down.
      // The HTML rides along so stream extraction can run post-dedupe.
      const check = await axios.get(embedUrl, { timeout: 5000, validateStatus: () => true, headers: HEADERS });
      if (check.status >= 400 || String(check.data).includes("Error Code:")) {
        lastError = `${name}: HTTP ${check.status}`;
        continue;
      }

      return {
        embedUrl,
        label: mirror.label,
        serverLabel: name,
        title,
        // true only when the server was matched inside the data-type block for
        // this mode; the untyped fallback cannot promise dub and must be
        // filtered out of DUB requests rather than claimed.
        dubCapable: verified,
        pageHtml: String(check.data ?? ""),
      };
    } catch (e) {
      lastError = `${name}: ${String(e).substring(0, 60)}`;
    }
  }
  throw new Error(lastError);
}

/**
 * Resolves playable sources per reachable Anikoto mirror. The mirrors are clones
 * of one WordPress install and usually resolve to the identical upstream player,
 * so results are deduped by embed URL — users get one button per distinct player
 * instead of four with the same link. The parallel probe still acts as failover
 * when a mirror domain is down.
 */
export async function getAnikotoEmbeds(
  title: string,
  ep: string,
  mode: "sub" | "dub" = "sub"
): Promise<StreamResult[]> {
  const key = `anikoto|${encodeURIComponent(title)}|${ep}|${mode}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.results;

  const settled = await Promise.all(
    getMirrors().map((m) => resolveFromMirror(m, title, ep, mode).catch(() => null))
  );

  const seen = new Set<string>();
  const resolved: AnikotoSource[] = [];
  let collapsed = false;
  for (const r of settled) {
    if (!r) continue;
    if (seen.has(r.embedUrl)) {
      collapsed = true;
      continue;
    }
    seen.add(r.embedUrl);
    resolved.push(r);
  }

  // Several mirrors pointed at the same player — drop the mirror suffix so the
  // server button just reads "Anikoto <player>".
  if (collapsed) {
    for (const r of resolved) r.label = "Anikoto";
  }

  // Unique player pages usually expose a direct stream (Megaplay HLS with
  // subtitle tracks and skip windows). Extraction runs once per unique embed
  // — mirrors share the same player, so it must happen after the dedupe
  // above, not per mirror. The final name prefers the extracted playerName
  // over the upstream label, which often names a different player entirely
  // (Anikoto lists its Megaplay player as "Vidstream-1"). On any failure the
  // embed remains as fallback.
  const results: StreamResult[] = await Promise.all(
    resolved.map(async (r) => {
      let extracted: MegaExtract | null = null;
      try {
        extracted = await extractPlayerSources(r.embedUrl, r.pageHtml);
      } catch { /* embed-only fallback */ }
      return {
        embedUrl: r.embedUrl,
        title: r.title,
        dubCapable: r.dubCapable,
        serverName: `${r.label} ${extracted?.playerName ?? r.serverLabel}`.trim(),
        ...(extracted ?? {}),
      };
    })
  );

  if (results.length > 0) cacheSet(key, results);
  return results;
}
