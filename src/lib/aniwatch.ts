import axios from "axios";
import * as cheerio from "cheerio";
import { StreamResult } from "./anikoto";
import { normalize, scoreTitle, MIN_SCORE } from "./title-score";
import { isSafeUrl } from "./safe-url";
import { envList, normalizeBase } from "./upstream";
import { extractPlayerSources, type MegaExtract } from "./megaplay";

// Rotating HiAnime-clone domains: the primary dies every few weeks (seizure /
// Cloudflare ban), so every request tries each base in order. Override with:
//   ANIWATCH_BASES=https://aniwatch.co.at,https://hianime.to
const DEFAULT_BASES = ["https://aniwatch.co.at"];
function getBases(): string[] {
  return envList("ANIWATCH_BASES", DEFAULT_BASES).map(normalizeBase);
}
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
function headersFor(base: string) {
  return { "User-Agent": AGENT, Referer: base + "/", "X-Requested-With": "XMLHttpRequest" };
}

const cache = new Map<string, { result: StreamResult; ts: number }>();
const CACHE_TTL = 1800_000;
const CACHE_MAX = 500;

// Sweep expired entries on write so a long-running server cannot accumulate
// one entry per (title, ep, mode) forever.
function cacheSet(key: string, result: StreamResult) {
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
  cache.set(key, { result, ts: Date.now() });
}

async function searchAnime(base: string, title: string): Promise<{ id: number; url: string; title: string }[]> {
  const res = await axios.get(`${base}/`, { params: { s: title }, headers: headersFor(base), timeout: 10000 });
  const $ = cheerio.load(res.data);
  const seen = new Set<number>();
  const candidates: { id: number; url: string; title: string; score: number }[] = [];

  $(".film-poster-ahref[data-id]").each((_, el) => {
    const node = $(el);
    const id = Number(node.attr("data-id"));
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name =
      node.attr("title") ||
      // The poster anchor is a *sibling* of .film-detail in hianime's markup,
      // so .closest() alone always misses — walk up then across.
      node.siblings(".film-detail").find(".film-name").text().trim() ||
      node.closest(".film-detail").find(".film-name").text().trim() ||
      node.parent().siblings(".film-detail").find(".film-name").text().trim();
    candidates.push({
      id,
      url: node.attr("href") || "",
      title: name,
      score: scoreTitle(title, name),
    });
  });

  return candidates
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((c) => ({ id: c.id, url: c.url, title: c.title }));
}

async function getEpisodeId(base: string, animeId: number, ep: string): Promise<number | null> {
  const res = await axios.get(`${base}/wp-json/hianime/v1/episode/list/${animeId}`, { headers: headersFor(base), timeout: 10000 });
  const $ = cheerio.load(res.data?.result ?? res.data?.html ?? "");
  const target = $(`.ep-item[data-number="${ep}"]`);
  const id = Number(target.attr("data-id"));
  return id || null;
}

function safeAtob(s: string): string {
  try {
    return atob(s);
  } catch {
    return "";
  }
}

async function getEmbedUrl(base: string, episodeId: number, mode: "sub" | "dub"): Promise<StreamResult | null> {
  const res = await axios.get(`${base}/wp-json/hianime/v1/episode/servers/${episodeId}`, { headers: headersFor(base), timeout: 10000 });
  const payload = res.data;

  type Srv = { name: string; hash?: string; serverId?: string };

  const htmlLike = payload?.result ?? payload?.html ?? (typeof payload === "string" ? payload : "");
  const $ = cheerio.load(htmlLike || "");
  // Type-specific servers first (data-type="sub" | "dub") — this is what makes the
  // sub/dub toggle actually switch audio tracks upstream.
  const readServers = (sel: string, into: Srv[]) => {
    $(sel).each((_, el) => {
      const hash = $(el).attr("data-hash") || undefined;
      const serverId = $(el).attr("data-server-id") || $(el).attr("data-id") || undefined;
      const name = $(el).attr("data-server-name") || $(el).text().trim();
      if (hash || serverId) into.push({ name, hash, serverId });
    });
  };

  const typed: Srv[] = [];
  // Whether the audio variant was actually verified for this mode: a typed
  // .server-item[data-type=...] match or a mode-keyed structured entry proves
  // it; the untyped fallback proves nothing and must not claim dubCapable.
  let verified = false;
  readServers(`.server-item[data-type="${mode}"]`, typed);
  if (typed.length > 0) verified = true;

  if (typed.length === 0) {
    // Only fall back to untyped servers when the payload carries no type
    // information at all. If the response *does* declare types (e.g. it offers
    // sub servers but no dub server for this episode), never silently hand back
    // the other audio variant — that is what made DUB play Japanese.
    const hasTypedServers = $(".server-item[data-type]").length > 0;
    if (!hasTypedServers) {
      readServers(".server-item", typed);
      if (typed.length === 0) {
        // Mode-aware: reading .sub while mode === "dub" was another path that
        // silently handed back Japanese audio. The mode key proves the variant.
        const structured =
          (payload?.result as Record<string, unknown> | undefined)?.[mode] ??
          (payload as Record<string, unknown> | undefined)?.[mode] ??
          [];
        for (const s of structured as { name?: string; hash?: string; serverId?: string }[]) {
          if (s && !typed.find((x) => x.serverId === s.serverId)) {
            typed.push({ name: s.name ?? "", hash: s.hash, serverId: s.serverId });
          }
        }
        if (typed.length > 0) verified = true;
      }
      // else: plain untyped .server-item fallback — verified stays false
    }
  }

  for (const srv of typed) {
    // The player page is base64-encoded in data-hash and carries the audio variant
    // (…/sub or …/dub) that the server list already matched for this mode.
    const embedUrl = srv.hash ? safeAtob(srv.hash) : "";
    if (!embedUrl.startsWith("http")) continue;
    // The decoded hash is upstream-controlled — SSRF gate before fetching it.
    if (!(await isSafeUrl(embedUrl))) continue;

    try {
      const check = await axios.get(embedUrl, { timeout: 5000, validateStatus: () => true, headers: headersFor(base), responseType: "text" });
      // 200 is not enough: taken-down embeds answer 200 with an "Error Code:"
      // body (same as Anikoto), which used to be handed to the player as alive.
      if (check.status < 400 && !String(check.data ?? "").includes("Error Code:")) {
        // Upgrade the embed to a direct stream (megaplay HLS or a Referer-gated
        // MP4) when the player page exposes one; the embed stays as the
        // caller's fallback either way. Name the server honestly: upstream
        // labels don't match the actual player ("VidSrc" serving Megaplay).
        let extracted: MegaExtract | null = null;
        try {
          extracted = await extractPlayerSources(embedUrl, String(check.data ?? ""));
        } catch { /* embed-only fallback */ }
        return {
          embedUrl,
          serverName: extracted?.playerName ? `Aniwatch ${extracted.playerName}` : `Aniwatch-${srv.name}`,
          title: "",
          dubCapable: verified,
          ...(extracted ?? {}),
        };
      }
    } catch { /* try next server */ }
  }
  return null;
}

export async function getAniwatchEmbed(title: string, ep: string, mode: "sub" | "dub" = "sub"): Promise<StreamResult> {
  const key = `aniwatch|${encodeURIComponent(title)}|${ep}|${mode}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  let lastError: string | null = null;
  for (const base of getBases()) {
    let candidates: { id: number; url: string; title: string }[];
    try {
      candidates = await searchAnime(base, title);
      // WordPress search chokes on long punctuation-heavy titles ("Frieren:
      // Beyond Journey's End" matched nothing while "Frieren" found the post).
      // Retry with the part before the colon before writing this base off.
      if (candidates.length === 0) {
        const short = title.split(/[:\u2013\u2014\u2212]/)[0].trim();
        if (short.length >= 3 && normalize(short) !== normalize(title)) {
          candidates = await searchAnime(base, short);
        }
      }
    } catch (e) {
      lastError = `${base}: ${String(e).substring(0, 80)}`;
      continue;
    }
    if (candidates.length === 0) {
      lastError = `"${title}" not found on Aniwatch (${base})`;
      continue;
    }

    // Walk the ranked candidates: search results mix seasons and spin-offs, and the
    // requested episode number often only exists on one of them.
    for (const candidate of candidates.slice(0, 5)) {
      const isExact = normalize(candidate.title) === normalize(title);
      // Per-candidate error so a failure on candidate 1 is not reported as
      // candidate 2's reason (stale lastError).
      let candidateError: string | null = null;
      let episodeId: number | null = null;
      try {
        episodeId = await getEpisodeId(base, candidate.id, ep);
      } catch (e) {
        candidateError = String(e).substring(0, 80);
        lastError = candidateError;
        // Falling past an exact title match substitutes a spin-off/season — fail instead.
        if (isExact) break;
        continue;
      }
      if (!episodeId) {
        candidateError = `Episode ${ep} not on "${candidate.title}"`;
        lastError = candidateError;
        if (isExact) break;
        continue;
      }

      let result: StreamResult | null = null;
      try {
        result = await getEmbedUrl(base, episodeId, mode);
      } catch (e) {
        candidateError = String(e).substring(0, 80);
      }
      if (result) {
        result.title = title;
        cacheSet(key, result);
        return result;
      }
      candidateError = candidateError ?? `No ${mode} server for "${candidate.title}" ep ${ep}`;
      lastError = candidateError;
      // Exact show matched but has no server for this mode: a lower-ranked
      // hit would be a different show — never hand that back.
      if (isExact) break;
    }
  }

  throw new Error(lastError || `No ${mode} source found on Aniwatch`);
}
