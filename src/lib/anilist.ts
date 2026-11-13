const ANILIST_URL = "https://graphql.anilist.co";

// ponytail: AniList + Kitsu replacements for Jikan (shutting down Oct 2026)

// AniList is queried via POST, which bypasses Next's data cache entirely —
// the home rails would refetch on every request without this in-process memo.
// Only successful AniList responses are stored: Kitsu fallbacks stay uncached
// so an AniList outage isn't masked for hours after it recovers.
const memoStore = new Map<string, { ts: number; value: unknown }>();
const MEMO_MAX = 100;

function memoGet<T>(key: string, ttlMs: number): T | null {
  const hit = memoStore.get(key);
  if (!hit || Date.now() - hit.ts >= ttlMs) return null;
  return hit.value as T;
}

function memoSet(key: string, value: unknown) {
  if (memoStore.size >= MEMO_MAX) {
    const oldest = memoStore.keys().next().value;
    if (oldest !== undefined) memoStore.delete(oldest);
  }
  memoStore.set(key, { ts: Date.now(), value });
}

const HOUR = 3600_000;
const SIX_HOURS = 6 * 3600_000;

// ── Search merge (finds upcoming/uncatalogued titles allanime doesn't have) ──

const ANI_SEARCH_QUERY = `query($search: String) { Page(perPage: 20) { media(search: $search, type: ANIME, isAdult: false) { id title { romaji english } coverImage { large } status } } }`;

export async function searchAniList(query: string): Promise<
  Array<{ _id: string; name: string; englishName?: string; malId: string; thumbnail: string; availableEpisodes: { sub: number; dub: number }; status?: string }>
> {
  const key = `ani:q:${query.trim().toLowerCase()}`;
  const hit = memoGet<Array<{ _id: string; name: string; englishName?: string; malId: string; thumbnail: string; availableEpisodes: { sub: number; dub: number }; status?: string }>>(key, 30 * 60_000);
  if (hit) return hit;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANI_SEARCH_QUERY, variables: { search: query } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const media = (json.data?.Page?.media ?? []) as AniListMedia[];
    const out = media.map((m) => ({
      _id: String(m.id),
      name: m.title.english || m.title.romaji,
      englishName: m.title.english || undefined,
      malId: "",
      thumbnail: m.coverImage?.large ?? "",
      availableEpisodes: { sub: 0, dub: 0 },
      status: m.status ?? "",
    }));
    memoSet(key, out);
    return out;
  } catch {
    return [];
  }
}

// ── Relations (sequels/prequels/related) ──

const RELATIONS_QUERY = `query($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    relations { edges { relationType node { id type title { romaji english } coverImage { large } } } }
  }
}`;

// Only linkable anime relations: manga SOURCE/ADAPTATION entries would dead-end
// on the watch page, and CHARACTER/SETTING/SUMMARY edges are noise.
const RELATION_FILTER = new Set(["SEQUEL", "PREQUEL", "SIDE_STORY", "ALTERNATIVE", "SPIN_OFF", "PARENT"]);
const RELATION_ORDER = ["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE"];

export interface AniRelation {
  id: number;
  relation: string;
  title: string;
  thumbnail: string;
}

export async function getAniRelations(opts: { id?: number; malId?: number }): Promise<AniRelation[]> {
  // Namespaced: AniList id 123 and MAL id 123 are different shows and used to
  // share one memo slot.
  const key = `ani:rel:id:${opts.id ?? ""}:mal:${opts.malId ?? ""}`;
  const hit = memoGet<AniRelation[]>(key, 24 * HOUR);
  if (hit) return hit;
  try {
    // AniList treats an explicit `id: null` as a lookup that resolves to
    // nothing (404), so only include the variables actually provided.
    const variables: { id?: number; idMal?: number } = {};
    if (opts.id) variables.id = opts.id;
    if (opts.malId) variables.idMal = opts.malId;
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: RELATIONS_QUERY, variables }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const media = json.data?.Media;
    if (!media) throw new Error("AniList: media not found");
    const edges = (media.relations?.edges ?? []) as Array<{
      relationType: string;
      node?: { id: number; type: string; title: { romaji: string; english: string | null }; coverImage?: { large?: string } };
    }>;
    const out = edges
      .filter((e) => RELATION_FILTER.has(e.relationType) && e.node?.type === "ANIME")
      .map((e) => ({
        id: e.node!.id,
        relation: e.relationType,
        title: e.node!.title.english || e.node!.title.romaji,
        thumbnail: e.node!.coverImage?.large ?? "",
      }))
      .sort((a, b) => RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation));
    memoSet(key, out);
    return out;
  } catch {
    return [];
  }
}

// ── Schedule (replaces jikan getAnimeSchedule) ──

const SCHEDULE_QUERY = `query($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    status
    nextAiringEpisode { airingAt episode }
  }
}`;

export async function getAnimeSchedule(malId: string): Promise<{ broadcast: string; status: string; nextEpisode: { episode: number; title: string } | null }> {
  const memoKey = `sched:${malId}`;
  const hit = memoGet<{ broadcast: string; status: string; nextEpisode: { episode: number; title: string } | null }>(memoKey, HOUR);
  if (hit) return hit;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SCHEDULE_QUERY, variables: { idMal: Number(malId) } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { broadcast: "", status: "", nextEpisode: null };
    const json = await res.json();
    const media = json.data?.Media;
    if (!media) return { broadcast: "", status: "", nextEpisode: null };

    const next = media.nextAiringEpisode;
    const out = {
      broadcast: "",
      status: media.status ?? "",
      nextEpisode: next ? { episode: next.episode, title: "" } : null,
    };
    memoSet(memoKey, out);
    return out;
  } catch {
    return { broadcast: "", status: "", nextEpisode: null };
  }
}

// ── Episode titles (replaces jikan getEpisodeTitles via Kitsu) ──

const KITSU_MAP_URL = "https://kitsu.io/api/edge/mappings";
const KITSU_ANIME_URL = "https://kitsu.io/api/edge/anime";

async function malToKitsuId(malId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${KITSU_MAP_URL}?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}`,
      { next: { revalidate: 3600 }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0]?.relationships?.item?.data?.id ?? null;
  } catch {
    return null;
  }
}

export async function getEpisodeTitles(malId: string): Promise<Record<string, string>> {
  const titles: Record<string, string> = {};
  try {
    const kitsuId = await malToKitsuId(malId);
    if (kitsuId) {
      let offset = 0;
      const limit = 20;
      let hasMore = true;

      while (hasMore && offset < 500) {
        const res = await fetch(
          `${KITSU_ANIME_URL}/${kitsuId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`,
          { next: { revalidate: 3600 }, signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) break;
        const json = await res.json();

        for (const ep of json.data ?? []) {
          const num = ep.attributes?.number;
          const name = ep.attributes?.canonicalTitle || ep.attributes?.titles?.en_jp || ep.attributes?.titles?.en || "";
          if (num != null && name) titles[String(num)] = name;
        }

        hasMore = json.data?.length === limit;
        offset += limit;
      }
    }
  } catch { /* Kitsu unavailable — fall through to Jikan */ }

  // Fallback: Jikan (MAL) episode list when Kitsu returned nothing.
  if (Object.keys(titles).length === 0) {
    try {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 10) {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${encodeURIComponent(malId)}/episodes?page=${page}`, {
          next: { revalidate: 3600 },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) break;
        const json = await res.json();
        for (const ep of json.data ?? []) {
          const num = ep.mal_id;
          const name = ep.title || ep.title_japanese || "";
          if (num != null && name) titles[String(num)] = name;
        }
        hasMore = (json.pagination?.has_next_page ?? false) === true;
        page += 1;
      }
    } catch { /* Jikan unavailable — degrade gracefully */ }
  }

  return titles;
}

// ── Trending & Popular (for homepage sections) ──

interface AniListMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string; english: string | null; native: string | null };
  coverImage: { large: string | null } | null;
  trending: number;
  popularity: number;
  averageScore: number | null;
  description: string | null;
  status: string | null;
  genres: string[];
}

const TRENDING_POPULAR_QUERY = `query($sort: [MediaSort]) {
  Page(perPage: 20) {
    media(sort: $sort, type: ANIME) {
      id idMal title { romaji english native }
      coverImage { large }
      trending popularity averageScore description status genres
    }
  }
}`;

function mapAniListMedia(m: AniListMedia) {
  return {
    _id: String(m.id),
    name: m.title.english || m.title.romaji,
    englishName: m.title.english || undefined,
    malId: m.idMal ? String(m.idMal) : "",
    thumbnail: m.coverImage?.large ?? "",
    // 0-10 scale, same as the top-rated mapper below — used by /api/random.
    score: m.averageScore != null ? Math.round(m.averageScore) / 10 : null,
    availableEpisodes: { sub: 0, dub: 0 },
  };
}

interface KitsuAnime {
  id: string;
  attributes: {
    canonicalTitle: string;
    titles?: Record<string, string>;
    posterImage?: { large?: string; original?: string };
    averageRating?: string;
    userCount?: number;
    ratingRank?: number;
    status?: string;
    synopsis?: string;
    coverImage?: { original?: string; large?: string };
    nextRelease?: string | null;
  };
}

function mapKitsuMedia(d: KitsuAnime) {
  const a = d.attributes;
  return {
    _id: `kitsu-${d.id}`,
    name: a.titles?.en || a.titles?.en_jp || a.canonicalTitle,
    englishName: a.titles?.en || undefined,
    malId: "",
    thumbnail: a.posterImage?.large || a.posterImage?.original || "",
    // Kitsu averageRating is 0-100 → 0-10 scale like AniList above.
    score: a.averageRating ? Math.round(Number(a.averageRating)) / 10 : null,
    availableEpisodes: { sub: 0, dub: 0 },
  };
}

async function getKitsuAnime(sort: string, limit = 20): Promise<ReturnType<typeof mapKitsuMedia>[]> {
  const res = await fetch(`${KITSU_ANIME_URL}?page[limit]=${limit}&sort=${sort}`, {
    headers: { Accept: "application/vnd.api+json" },
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Kitsu ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map(mapKitsuMedia);
}

export async function getAniTrending() {
  const cached = memoGet<ReturnType<typeof mapAniListMedia>[]>("ani:trending", SIX_HOURS);
  if (cached) return cached;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: TRENDING_POPULAR_QUERY, variables: { sort: ["TRENDING_DESC"] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const out = (json.data?.Page?.media ?? []).map(mapAniListMedia);
    memoSet("ani:trending", out);
    return out;
  } catch {
    return getKitsuAnime("-favoritesCount");
  }
}

export async function getAniPopular() {
  const cached = memoGet<ReturnType<typeof mapAniListMedia>[]>("ani:popular", SIX_HOURS);
  if (cached) return cached;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: TRENDING_POPULAR_QUERY, variables: { sort: ["POPULARITY_DESC"] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const out = (json.data?.Page?.media ?? []).map(mapAniListMedia);
    memoSet("ani:popular", out);
    return out;
  } catch {
    return getKitsuAnime("-userCount");
  }
}

const TOP_RATED_QUERY = `query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false) { id idMal title { romaji english } coverImage { large } averageScore genres } } }`;

export async function getAniTopRated() {
  const cached = memoGet<{ _id: string; malId: string; title: string; englishName: string; thumbnail: string; score: number | null; genres: string[] }[]>("ani:top", SIX_HOURS);
  if (cached) return cached;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: TOP_RATED_QUERY }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const media = json?.data?.Page?.media ?? [];
    const out = media.map((a: AniListMedia) => ({
      _id: String(a.id),
      malId: a.idMal ? String(a.idMal) : "",
      title: a.title.romaji,
      englishName: a.title.english ?? "",
      thumbnail: a.coverImage?.large ?? "",
      score: a.averageScore != null ? Math.round(a.averageScore) / 10 : null,
      genres: a.genres ?? [],
    }));
    memoSet("ani:top", out);
    return out;
  } catch {
    const res = await fetch(`${KITSU_ANIME_URL}?page[limit]=20&sort=ratingRank`, {
      headers: { Accept: "application/vnd.api+json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data ?? []).map((d: KitsuAnime) => ({
      // kitsu- prefix: without it the fallback ids are routed as AniList ids
      // and resolve to the wrong show (mapKitsuMedia convention).
      _id: `kitsu-${d.id}`,
      malId: "",
      title: d.attributes.titles?.en || d.attributes.titles?.en_jp || d.attributes.canonicalTitle,
      englishName: d.attributes.titles?.en || "",
      thumbnail: d.attributes.posterImage?.large || d.attributes.posterImage?.original || "",
      score: d.attributes.averageRating ? Math.round(Number(d.attributes.averageRating)) / 10 : null,
      genres: [],
    }));
  }
}

// ── Hidden gems: highly rated but not widely watched (feeds /api/random) ──

const HIDDEN_GEMS_QUERY = `query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false, averageScore_greater: 75, popularity_lesser: 60000) { id idMal title { romaji english } coverImage { large } averageScore genres } } }`;

export async function getAniHiddenGems() {
  type Gem = { _id: string; malId: string; score: number | null };
  const cached = memoGet<Gem[]>("ani:gems", SIX_HOURS);
  if (cached) return cached;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: HIDDEN_GEMS_QUERY }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const media = json?.data?.Page?.media ?? [];
    const out: Gem[] = media.map((a: AniListMedia) => ({
      _id: String(a.id),
      malId: a.idMal ? String(a.idMal) : "",
      score: a.averageScore != null ? Math.round(a.averageScore) / 10 : null,
    }));
    memoSet("ani:gems", out);
    return out;
  } catch {
    return [];
  }
}

// ── Spotlight (ongoing/new anime with descriptions) ──

const SPOTLIGHT_QUERY = `query { Page(page: 1, perPage: 10) { media(status: RELEASING, type: ANIME, isAdult: false, sort: UPDATED_AT_DESC) { id idMal title { romaji english native } coverImage { large } trending popularity averageScore description status genres } } }`;

export async function getAniSpotlight() {
  type SpotlightCard = {
    _id: string; name: string; englishName?: string; malId: string; thumbnail: string;
    description: string; genres: string[]; status: string; availableEpisodes: { sub: number; dub: number };
  };
  const cached = memoGet<SpotlightCard[]>("ani:spotlight", SIX_HOURS);
  if (cached) return cached;
  try {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SPOTLIGHT_QUERY }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    const media = json?.data?.Page?.media ?? [];
    const out: SpotlightCard[] = media.map((m: AniListMedia) => ({
      _id: String(m.id),
      name: m.title.english || m.title.romaji,
      englishName: m.title.english || undefined,
      malId: m.idMal ? String(m.idMal) : "",
      thumbnail: m.coverImage?.large ?? "",
      description: (m.description ?? "").replace(/<[^>]*>?/gm, ""),
      genres: m.genres ?? [],
      status: m.status ?? "",
      availableEpisodes: { sub: 0, dub: 0 },
    }));
    memoSet("ani:spotlight", out);
    return out;
  } catch {
    // AniList down — use Kitsu ongoing anime
    try {
      const res = await fetch(`${KITSU_ANIME_URL}?filter[status]=current&page[limit]=10&sort=-favoritesCount`, {
        headers: { Accept: "application/vnd.api+json" },
        next: { revalidate: 3600 },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const json = await res.json();
      return (json.data ?? []).map((d: KitsuAnime) => ({
        _id: `kitsu-${d.id}`,
        name: d.attributes.titles?.en || d.attributes.titles?.en_jp || d.attributes.canonicalTitle,
        englishName: d.attributes.titles?.en || undefined,
        malId: "",
        thumbnail: d.attributes.posterImage?.large || d.attributes.posterImage?.original || "",
        description: (d.attributes.synopsis ?? "").replace(/<[^>]*>?/gm, ""),
        genres: [],
        status: "RELEASING",
        availableEpisodes: { sub: 0, dub: 0 },
      }));
    } catch {
      return [];
    }
  }
}
