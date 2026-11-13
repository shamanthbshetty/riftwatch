import { NextRequest, NextResponse } from "next/server";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const ANILIST_URL = "https://graphql.anilist.co";
const SCHEDULE_QUERY = `query ($start: Int, $end: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) { airingAt media { idMal title { romaji english } coverImage { large } averageScore genres } } } }`;

interface AniListSchedule {
  airingAt: number;
  media: {
    idMal: number | null;
    title: { romaji: string; english?: string };
    coverImage: { large: string };
    averageScore: number | null;
    genres: string[];
  };
}

type DayEntry = { title: string; time: string; malId: number; thumbnail: string; score: number | null; genres: string[] };
type DayData = { entries: DayEntry[]; hasMore: boolean };

// Cache the complete array of AniList schedules for the week
let fullScheduleCache: { schedules: AniListSchedule[]; ts: number } | null = null;
const CACHE_TTL = 30 * 60_000;

function getDayOfWeek(ts: number): string {
  const d = new Date(ts * 1000);
  return DAYS[d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1];
}

function getDayOfWeekFromDate(dateStr: string): string {
  const d = new Date(dateStr);
  // UTC, matching getDayOfWeek — server-local getDay() made the fallback
  // schedule shift by a day depending on where the server runs.
  const day = d.getUTCDay();
  return DAYS[day === 0 ? 6 : day - 1];
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  // ponytail: format in JST to match component's formatTimeJST expectation
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${String(jst.getHours()).padStart(2, "0")}:${String(jst.getMinutes()).padStart(2, "0")}`;
}

function formatTimeFromDate(dateStr: string): string {
  const d = new Date(dateStr);
  // JST, matching formatTime — local getHours() made times depend on the
  // server timezone while the main path always shows JST.
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${String(jst.getHours()).padStart(2, "0")}:${String(jst.getMinutes()).padStart(2, "0")}`;
}

async function fetchAllAiringSchedules(start: number, end: number): Promise<AniListSchedule[]> {
  const all: AniListSchedule[] = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= 10) {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SCHEDULE_QUERY, variables: { start, end, page } }),
      // No timeout here meant one hung AniList request blocked the whole route.
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`anilist ${res.status}`);
    }
    const json = await res.json();
    const schedules: AniListSchedule[] = json?.data?.Page?.airingSchedules ?? [];
    all.push(...schedules);
    hasNextPage = json?.data?.Page?.pageInfo?.hasNextPage ?? false;
    page++;
  }

  return all;
}

// Kitsu fallback: get currently airing anime with nextRelease timestamps
const KITSU_URL = "https://kitsu.io/api/edge/anime";

async function fetchKitsuSchedule(): Promise<Record<string, DayData>> {
  const res = await fetch(`${KITSU_URL}?filter[status]=current&page[limit]=20&sort=-favoritesCount`, {
    headers: { Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Kitsu ${res.status}`);
  const json = await res.json();

  const grouped: Record<string, DayEntry[]> = {};
  for (const day of DAYS) grouped[day] = [];

  for (const d of json.data ?? []) {
    const a = d.attributes;
    const nextRelease: string | null = a.nextRelease;
    if (!nextRelease) continue;

    const day = getDayOfWeekFromDate(nextRelease);
    grouped[day].push({
      title: a.titles?.en || a.titles?.en_jp || a.canonicalTitle,
      time: formatTimeFromDate(nextRelease),
      malId: 0,
      thumbnail: a.posterImage?.large || a.posterImage?.original || "",
      score: a.averageRating ? Math.round(Number(a.averageRating)) / 10 : null,
      genres: [],
    });
  }

  const result: Record<string, DayData> = {};
  for (const day of DAYS) {
    const entries = grouped[day].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    result[day] = { entries, hasMore: false };
  }
  return result;
}

export async function GET(req: NextRequest) {
  // Number("abc") is NaN → slice(0, NaN) returned an empty schedule for any
  // malformed page param. Coerce defensively.
  const pageRaw = Number(req.nextUrl.searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 4 * 86400;
    const end = now + 4 * 86400;

    let schedules: AniListSchedule[] = [];

    if (fullScheduleCache && Date.now() - fullScheduleCache.ts < CACHE_TTL) {
      schedules = fullScheduleCache.schedules;
    } else {
      schedules = await fetchAllAiringSchedules(start, end);
      fullScheduleCache = { schedules, ts: Date.now() };
    }

    const grouped: Record<string, DayEntry[]> = {};
    for (const s of schedules) {
      const day = getDayOfWeek(s.airingAt);
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push({
        title: s.media.title.english || s.media.title.romaji,
        time: formatTime(s.airingAt),
        malId: s.media.idMal ?? 0,
        thumbnail: s.media.coverImage?.large ?? "",
        score: s.media.averageScore != null ? Math.round(s.media.averageScore) / 10 : null,
        genres: s.media.genres ?? [],
      });
    }

    // Cap pagination: 10 pages × 15 = 150 entries per day is far beyond any
    // real day, and unbounded page values were only ever an abuse vector.
    const limit = Math.min(page * 15, 150);

    const result: Record<string, DayData> = {};
    for (const day of DAYS) {
      const entries = (grouped[day] ?? [])
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
      result[day] = { entries, hasMore: (grouped[day]?.length ?? 0) > entries.length };
    }

    return NextResponse.json(result);
  } catch {
    // AniList is down — fall back to Kitsu currently airing data
    try {
      const result = await fetchKitsuSchedule();
      return NextResponse.json(result);
    } catch {
      const empty: Record<string, DayData> = {};
      for (const day of DAYS) empty[day] = { entries: [], hasMore: false };
      return NextResponse.json(empty);
    }
  }
}
