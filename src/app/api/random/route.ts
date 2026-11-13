import { NextRequest, NextResponse } from "next/server";
import { getAniTrending, getAniPopular, getAniTopRated, getAniHiddenGems } from "@/lib/anilist";
import { getTrending, getTrendingTV, getTopRatedMovies, getTopRatedTV } from "@/lib/movies";
import type { MovieResult } from "@/lib/movies";

interface RandomCandidate {
  _id?: string;
  malId?: string;
  score?: number | null;
}

/** Minimum average score (0-10 anime / TMDB scale). */
const MIN_SCORE = 7;

/** Share of shuffles that surface an underrated pick instead of a mainstream one. */
const GEMS_SHARE = 1 / 3;

function ids(items: RandomCandidate[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const id = item._id || item.malId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (item.score != null && item.score >= MIN_SCORE) out.push(id);
  }
  return out;
}

async function moviePool(): Promise<string> {
  const [trending, trendingTV, top, topTV] = await Promise.all([
    getTrending().catch(() => []),
    getTrendingTV().catch(() => []),
    getTopRatedMovies().catch(() => ({ results: [] as MovieResult[] })),
    getTopRatedTV().catch(() => ({ results: [] as MovieResult[] })),
  ]);
  const seen = new Set<string>();
  const pool: string[] = [];
  const add = (list: MovieResult[], type: "movie" | "tv") => {
    for (const r of list) {
      const k = `${type}-${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.vote_average >= MIN_SCORE) pool.push(`/movies/${r.id}?type=${type}`);
    }
  };
  add(trending, "movie");
  add(trendingTV, "tv");
  add(top.results, "movie");
  add(topTV.results, "tv");
  if (pool.length === 0) return "/";
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function GET(req: NextRequest) {
  const wantsMovies = req.nextUrl.searchParams.get("type") === "movie";
  try {
    if (wantsMovies) {
      // JSON (not a redirect): the client pushes one history entry per shuffle,
      // so Back lands on the previous pick instead of re-rolling.
      return NextResponse.json({ url: await moviePool() });
    }
    const [trending, popular, top, gems] = await Promise.all([
      getAniTrending().catch(() => []),
      getAniPopular().catch(() => []),
      getAniTopRated().catch(() => []),
      getAniHiddenGems().catch(() => []),
    ]);
    const main = ids([...trending, ...popular, ...top] as RandomCandidate[]);
    const gemIds = ids(gems as RandomCandidate[]);
    // Prefer the underrated pool ~1/3 of the time (when it loaded).
    const pool = gemIds.length > 0 && (main.length === 0 || Math.random() < GEMS_SHARE) ? gemIds : main;
    if (pool.length === 0) return NextResponse.json({ url: "/" });
    return NextResponse.json({ url: `/anime/${pool[Math.floor(Math.random() * pool.length)]}` });
  } catch {
    return NextResponse.json({ url: wantsMovies ? "/?tab=movies" : "/" });
  }
}
