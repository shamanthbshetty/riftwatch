export interface SearchResult {
  _id: string;
  name: string;
  englishName?: string;
  malId: string;
  thumbnail: string;
  availableEpisodes: { sub: number; dub: number };
  /** AniList status when the row came from the AniList merge (e.g. NOT_YET_RELEASED). */
  status?: string;
}

export interface ShowDetail {
  _id: string;
  name: string;
  englishName?: string;
  thumbnail: string;
  description: string;
  status: string;
  score: number;
  malId: string;
  genres: string[];
  tags: string[];
  availableEpisodes: { sub: number; dub: number };
  availableEpisodesDetail: { sub: string[]; dub: string[] };
}

import { envStr, normalizeBase } from "./upstream";

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";
const ANILIST_URL = "https://graphql.anilist.co";

// Primary frontend mirror + backend API host are env-overridable so a domain
// seizure is a config change (or restart) instead of a source edit. Defaults
// preserve the previous hardcoded behavior (mkissa.to page, mkissa.net API).
function getReferer(): string {
  const mirror = envStr("ALLANIME_MIRROR", "mkissa.to")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return `https://${mirror || "mkissa.to"}`;
}

function getApiBases(): string[] {
  const backend = envStr("ALLANIME_BACKEND", "mkissa.net")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "") || "mkissa.net";
  const bases = [`https://api.${backend}`];
  // ALLANIME_FALLBACK_MIRRORS="allanime.day|api.allanime.day, ..." — each entry
  // is either "page|backend" (backend half becomes the api host) or a full
  // backend/api URL used as-is.
  const raw = (process.env.ALLANIME_FALLBACK_MIRRORS ?? "").trim();
  if (raw) {
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const backendHalf = entry.includes("|") ? entry.split("|")[1].trim() : entry;
      if (!backendHalf) continue;
      const base = /^https?:\/\//i.test(backendHalf)
        ? normalizeBase(backendHalf)
        : backendHalf.startsWith("api.")
          ? `https://${backendHalf}`
          : `https://api.${backendHalf.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
      if (!bases.includes(base)) bases.push(base);
    }
  }
  return bases;
}

// Optional egress wrapping for the AllAnime API calls. Two modes work with
// plain fetch (no extra deps):
//   ALLANIME_PROXY=https://host/?url=$URL  -> GET host/?url=<encoded target>
//   ALLANIME_PROXY=https://host             -> GET https://host/<target>
// A CONNECT-tunnel proxy (http://user:pass@host:port) cannot be driven by
// fetch without an agent — it is ignored with a warning, direct is tried.
let proxyWarned = false;
function applyProxy(target: string): string {
  const proxy = (process.env.ALLANIME_PROXY ?? "").trim();
  if (!proxy) return target;
  if (proxy.includes("$URL")) return proxy.replace("$URL", encodeURIComponent(target));
  if (proxy.includes("@") || /^http:\/\/[^/]*:\d+\/?$/.test(proxy)) {
    if (!proxyWarned) {
      proxyWarned = true;
      console.warn("[allanime] ALLANIME_PROXY looks like a CONNECT tunnel — plain fetch cannot tunnel; trying direct connection");
    }
    return target;
  }
  return `${normalizeBase(proxy)}/${target}`;
}

const anilistTitleCache = new Map<string, { title: string | null; ts: number }>();
const ANILIST_TITLE_TTL = 60 * 60_000; // 1 hour
const ANILIST_CACHE_MAX = 1000;

// Cache misses too ("no english title found") — otherwise every search re-fires
// two upstream lookups for every unresolved title, every time.
function cacheTitle(name: string, title: string | null) {
  if (anilistTitleCache.size >= ANILIST_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of anilistTitleCache) {
      if (now - v.ts >= ANILIST_TITLE_TTL) anilistTitleCache.delete(k);
    }
    while (anilistTitleCache.size >= ANILIST_CACHE_MAX) {
      const oldest = anilistTitleCache.keys().next().value;
      if (oldest === undefined) break;
      anilistTitleCache.delete(oldest);
    }
  }
  anilistTitleCache.set(name, { title, ts: Date.now() });
}

async function resolveEnglishTitle(name: string): Promise<string | null> {
  const cached = anilistTitleCache.get(name);
  if (cached && Date.now() - cached.ts < ANILIST_TITLE_TTL) return cached.title;

  // Try AniList first
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME) { title { english romaji } } } }`,
        variables: { search: name },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      const english = json.data?.Page?.media?.[0]?.title?.english;
      if (english) {
        cacheTitle(name, english);
        return english;
      }
    }
  } catch { /* ignore */ }

  // Fallback: Kitsu search
  try {
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(name)}&page[limit]=1`, {
      headers: { Accept: "application/vnd.api+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      const en = json.data?.[0]?.attributes?.titles?.en;
      if (en) {
        cacheTitle(name, en);
        return en;
      }
    }
  } catch { /* ignore */ }

  cacheTitle(name, null);
  return null;
}

// Resolve at most this many titles per search, with bounded parallelism:
// 40 sequential lookups made every search take 12–40 s, while firing all 40 at
// once would burn AniList's rate limit.
const TITLE_LOOKUP_CONCURRENCY = 5;
const TITLE_LOOKUP_LIMIT = 12;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface GqlError {
  message?: string;
}

async function gql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
  const bases = getApiBases();
  const referer = getReferer();
  let lastError: unknown = null;
  for (const base of bases) {
    const url = applyProxy(`${base}/api`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": AGENT, Referer: referer },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        lastError = new Error(`Allanime ${res.status}`);
        continue;
      }
      const json = await res.json();
      const errors = json.errors as GqlError[] | undefined;
      if (errors?.length) {
        lastError = new Error(errors.map((e) => e.message).join(", "));
        continue;
      }
      return json.data as T;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Allanime unreachable (${bases.join(", ")})`);
}

const SEARCH_GQL = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) {
  shows(search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin) {
    edges { _id name englishName nativeName thumbnail availableEpisodes __typename }
  }
}`;

interface SearchResponse {
  shows?: { edges?: Array<{ _id: string; name: string; englishName?: string;     thumbnail?: string; availableEpisodes?: { sub?: string; dub?: string } }> };
}

interface ShowResponse {
  show?: {
    _id: string;
    name: string;
    englishName?: string;
    thumbnail?: string;
    description?: string;
    status?: string;
    availableEpisodesDetail?: { sub?: string[]; dub?: string[] };
  };
}

// Search results memoized 30 min (POST gql bypasses Next's data cache; both
// /api/search and the detail-page episode lookup funnel through here). Failures
// throw before the store, so an upstream outage never gets cached.
const searchCache = new Map<string, { ts: number; results: SearchResult[] }>();
const SEARCH_TTL = 30 * 60_000;
const SEARCH_CACHE_MAX = 100;

function cacheSearch(query: string, results: SearchResult[]) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of searchCache) {
      if (now - v.ts >= SEARCH_TTL) searchCache.delete(k);
    }
    while (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = searchCache.keys().next().value;
      if (oldest === undefined) break;
      searchCache.delete(oldest);
    }
  }
  searchCache.set(query, { ts: Date.now(), results });
}

export async function searchAnime(query: string): Promise<SearchResult[]> {
  const key = query.trim().toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < SEARCH_TTL) return cached.results;
  const data = await gql<SearchResponse>(SEARCH_GQL, {
    search: { allowAdult: false, allowUnknown: false, query },
    limit: 40,
    page: 1,
    translationType: "sub",
    countryOrigin: "ALL",
  });
  const edges = data.shows?.edges ?? [];

  // Only rows missing englishName need a lookup, only the first
  // TITLE_LOOKUP_LIMIT of those (search shows the top hits first), and the
  // lookups run with bounded parallelism instead of one-by-one.
  const needsLookup: number[] = [];
  edges.forEach((s, i) => {
    if (!s.englishName && needsLookup.length < TITLE_LOOKUP_LIMIT) needsLookup.push(i);
  });
  const resolved = new Map<number, string | null>();
  await mapLimit(needsLookup, TITLE_LOOKUP_CONCURRENCY, async (i) => {
    resolved.set(i, await resolveEnglishTitle(edges[i].name));
  });

  const results: SearchResult[] = edges.map((s, i) => ({
    _id: s._id,
    name: s.englishName || resolved.get(i) || s.name,
    englishName: s.englishName || undefined,
    malId: "",
    thumbnail: s.thumbnail ?? "",
    availableEpisodes: {
      sub: parseInt(s.availableEpisodes?.sub ?? "") || 0,
      dub: parseInt(s.availableEpisodes?.dub ?? "") || 0,
    },
  }));
  cacheSearch(key, results);
  return results;
}

const SHOW_GQL = `query($showId: String!) {
  show(_id: $showId) {
    _id name englishName nativeName thumbnail description status
    availableEpisodesDetail
  }
}`;

// getShow is hit by both /api/episodes and /api/stream (resolveShowName) on
// every page load, and allanime re-queries + re-resolves the English title each
// time — memoize the settled result (incl. "not catalogued" nulls); throws are
// never stored so an outage isn't cached.
const showCache = new Map<string, { ts: number; show: ShowDetail | null }>();
const SHOW_TTL = 30 * 60_000;
const SHOW_CACHE_MAX = 200;

function cacheShow(showId: string, show: ShowDetail | null) {
  if (showCache.size >= SHOW_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of showCache) {
      if (now - v.ts >= SHOW_TTL) showCache.delete(k);
    }
    while (showCache.size >= SHOW_CACHE_MAX) {
      const oldest = showCache.keys().next().value;
      if (oldest === undefined) break;
      showCache.delete(oldest);
    }
  }
  showCache.set(showId, { ts: Date.now(), show });
}

export async function getShow(showId: string, retries = 2): Promise<ShowDetail | null> {
  const cached = showCache.get(showId);
  if (cached && Date.now() - cached.ts < SHOW_TTL) return cached.show;
  try {
    const data = await gql<ShowResponse>(SHOW_GQL, { showId });
    const s = data.show;
    if (!s) {
      cacheShow(showId, null);
      return null;
    }
    const rawName = s.englishName || s.name;
    const resolvedName = s.englishName ? rawName : (await resolveEnglishTitle(s.name)) || rawName;
    const show: ShowDetail = {
    _id: s._id,
    name: resolvedName,
    englishName: s.englishName || undefined,
    thumbnail: s.thumbnail ?? "",
    description: s.description ? s.description.replace(/<[^>]*>?/gm, "") : "",
    status: s.status ?? "",
    score: 0,
    malId: "",
    genres: [],
    tags: [],
    availableEpisodes: {
      sub: s.availableEpisodesDetail?.sub?.length ?? 0,
      dub: s.availableEpisodesDetail?.dub?.length ?? 0,
    },
    availableEpisodesDetail: {
      sub: (s.availableEpisodesDetail?.sub ?? []).sort((a: string, b: string) => parseFloat(a) - parseFloat(b)),
      dub: (s.availableEpisodesDetail?.dub ?? []).sort((a: string, b: string) => parseFloat(a) - parseFloat(b)),
    },
  };
  cacheShow(showId, show);
  return show;
} catch (e) {
  if (retries > 0) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return getShow(showId, retries - 1);
  }
  throw new Error(`Failed to fetch show: ${String(e)}`);
}
}


