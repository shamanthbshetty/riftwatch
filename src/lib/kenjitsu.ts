import { StreamResult } from "./anikoto";
import { scoreTitle, MIN_SCORE } from "./title-score";
import { envList, envStr, normalizeBase } from "./upstream";

// Free Vercel deployment — can be deleted or rate-limited at any time, so the
// base is env-overridable with multi-base fallback:
//   KENJITSU_BASES=https://kenjitsu.vercel.app,https://kenjitsu-backup.vercel.app
// (KENJITSU_BASE is accepted as a singular alias.)
const DEFAULT_KENJITSU_BASE = "https://kenjitsu.vercel.app";
function getBases(): string[] {
  const singular = envStr("KENJITSU_BASE", "").trim();
  const defaults = singular && singular !== DEFAULT_KENJITSU_BASE
    ? [singular, DEFAULT_KENJITSU_BASE]
    : [DEFAULT_KENJITSU_BASE];
  return envList("KENJITSU_BASES", defaults).map(normalizeBase);
}
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

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
    // Still full after expiry sweep → drop oldest (Map preserves insertion order).
    while (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(key, { results, ts: Date.now() });
}

// Reject any candidate that does not resemble the requested show — never fall
// through to an arbitrary first hit.
function pickBest(query: string, results: { id: string; totalEpisodes: number; name: string }[]) {
  let best: (typeof results)[number] | null = null;
  let bestScore = 0;
  for (const r of results) {
    const s = scoreTitle(query, r.name);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  // Same identity gate as the other providers — a stricter ad-hoc threshold
  // here rejected valid matches with small title differences.
  return bestScore >= MIN_SCORE ? best : null;
}

interface AnizoneEpisode {
  episodeId: string;
  episodeNumber: number;
}

interface AnimeheavenEpisode {
  episodeId: string;
  episodeNumber: number;
}

async function fetchJson<T = unknown>(url: string, timeout = 10000): Promise<T | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function searchAnizone(base: string, title: string): Promise<{ id: string; totalEpisodes: number } | null> {
  const data = await fetchJson<{ data: { id: string; totalEpisodes: number; name: string }[] }>(
    `${base}/api/anizone/anime/search?q=${encodeURIComponent(title)}`
  );
  const results = data?.data;
  if (!results || results.length === 0) return null;
  return pickBest(title, results);
}

async function searchAnimeheaven(base: string, title: string): Promise<{ id: string; totalEpisodes: number } | null> {
  const data = await fetchJson<{ data: { id: string; totalEpisodes: number; name: string }[] }>(
    `${base}/api/animeheaven/anime/search?q=${encodeURIComponent(title)}`
  );
  const results = data?.data;
  if (!results || results.length === 0) return null;
  return pickBest(title, results);
}

async function getAnizoneStream(base: string, title: string, ep: string, mode: "sub" | "dub" = "sub"): Promise<StreamResult | null> {
  const show = await searchAnizone(base, title);
  if (!show) return null;

  const detail = await fetchJson<{ providerEpisodes: AnizoneEpisode[] }>(
    `${base}/api/anizone/anime/${encodeURIComponent(show.id)}`
  );
  const episodes = detail?.providerEpisodes;
  if (!episodes || episodes.length === 0) return null;

  const target = episodes.find((e) => String(e.episodeNumber) === ep);
  // No fallback to episodes[0]: serving a wrong episode on a wrong ID match is
  // worse than reporting the provider had nothing.
  if (!target) return null;
  const sourcesData = await fetchJson<{ headers?: { Referer?: string }; data: { sources: { url: string; isM3u8: boolean; type: string }[]; subtitles: { url: string; lang: string }[] } }>(
    `${base}/api/anizone/sources/${encodeURIComponent(target.episodeId)}?version=${mode}`
  );
  if (!sourcesData?.data?.sources || sourcesData.data.sources.length === 0) return null;

  const src = sourcesData.data.sources.find((s) => s.isM3u8) || sourcesData.data.sources[0];
  const referer = sourcesData.headers?.Referer || "https://anizone.to/";
  const subtitles = (sourcesData.data.subtitles ?? []).map((s) => ({
    label: s.lang || "Subtitles",
    url: `/api/movies/subtitle-proxy?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(referer)}`,
    srclang: "en",
  }));

  return {
    embedUrl: "",
    serverName: "Anizone",
    title,
    streamUrl: `/api/movies/m3u8-proxy?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(referer)}`,
    subtitles,
    // Anizone's sources endpoint ignores the requested version and always
    // returns the same Japanese-audio stream, so it can never serve a dub.
    dubCapable: false,
  };
}

async function getAnimeheavenStream(base: string, title: string, ep: string, mode: "sub" | "dub" = "sub"): Promise<StreamResult | null> {
  const show = await searchAnimeheaven(base, title);
  if (!show) return null;

  const detail = await fetchJson<{ providerEpisodes: AnimeheavenEpisode[] }>(
    `${base}/api/animeheaven/anime/${encodeURIComponent(show.id)}`
  );
  const episodes = detail?.providerEpisodes;
  if (!episodes || episodes.length === 0) return null;

  const target = episodes.find((e) => String(e.episodeNumber) === ep);
  if (!target) return null;
  const sourcesData = await fetchJson<{ headers?: { Referer?: string }; data: { sources: { url: string; isM3u8: boolean; type: string }[]; subtitles?: { url: string; lang: string; label?: string }[] } }>(
    `${base}/api/animeheaven/sources/${encodeURIComponent(target.episodeId)}?version=${mode}`
  );
  if (!sourcesData?.data?.sources || sourcesData.data.sources.length === 0) return null;

  const src = sourcesData.data.sources[0];
  const referer = sourcesData.headers?.Referer || "https://animeheaven.me/";

  // URL shape wins over the upstream flag: an .m3u8 URL routed to the mp4
  // proxy (or vice versa) plays nothing.
  const isMp4 = !src.url.includes(".m3u8") && (src.url.includes(".mp4") || !src.isM3u8);
  const proxyPath = isMp4 ? "/api/movies/mp4-proxy" : "/api/movies/m3u8-proxy";

  const subtitles = (sourcesData.data.subtitles ?? []).map((s) => ({
    label: s.label || s.lang || "Subtitles",
    url: `/api/movies/subtitle-proxy?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(referer)}`,
    srclang: (s.lang || "en").slice(0, 2).toLowerCase(),
  }));

  return {
    embedUrl: "",
    serverName: "Animeheaven",
    title,
    streamUrl: `${proxyPath}?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(referer)}`,
    subtitles,
    // Verified upstream: ?version=sub and ?version=dub return byte-identical
    // URLs, so this provider is sub-only.
    dubCapable: false,
  };
}

export async function getKenjitsuStream(title: string, ep: string, mode: "sub" | "dub" = "sub"): Promise<StreamResult[]> {
  const key = `kenjitsu|${encodeURIComponent(title)}|${ep}|${mode}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.results;

  for (const base of getBases()) {
    const [anizone, animeheaven] = await Promise.all([
      getAnizoneStream(base, title, ep, mode).catch(() => null),
      getAnimeheavenStream(base, title, ep, mode).catch(() => null),
    ]);

    const results: StreamResult[] = [];
    if (anizone) results.push(anizone);
    if (animeheaven) results.push(animeheaven);

    if (results.length > 0) {
      cacheSet(key, results);
      return results;
    }
  }

  return [];
}
