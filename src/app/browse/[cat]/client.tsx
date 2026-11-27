"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, notFound } from "next/navigation";
import { useRouter } from "@/lib/tauri-router";
import { Search } from "lucide-react";
import AnimeCard from "@/components/AnimeCard";
import MovieCard from "@/components/MovieCard";
import EmptyState, { CardGridSkeleton } from "@/components/Skeleton";
import { cachedFetch } from "@/lib/cache";
import type { MovieResult } from "@/lib/movies";

interface BrowseItem {
  _id: string;
  name?: string;
  title?: string;
  englishName?: string;
  thumbnail: string;
  malId?: string;
  availableEpisodes?: { sub: number; dub: number };
  score?: number | null;
}

interface MoviesTrendingJson {
  movies: MovieResult[];
  tv: MovieResult[];
}

interface MoviesTopJson {
  movies: { results: MovieResult[] };
  tv: { results: MovieResult[] };
}

interface CatMeta {
  title: string;
  endpoint: string;
  note?: string;
  kind: "anime" | "movie";
  /** Forced onto movie cards (rails do the same); tv lists need explicit "tv". */
  mediaType?: "movie" | "tv";
  showScore?: boolean;
  pickMovies?: (d: unknown) => MovieResult[];
}

const CATS: Record<string, CatMeta> = {
  trending: { title: "Trending Now", endpoint: "/api/trending", kind: "anime" },
  popular: { title: "Most Popular", endpoint: "/api/popular", note: "Last 30 days", kind: "anime" },
  "top-rated": { title: "Top Rated", endpoint: "/api/top-rated", kind: "anime" },
  "movies-trending": {
    title: "Trending Movies", endpoint: "/api/movies/trending", kind: "movie", mediaType: "movie",
    pickMovies: (d) => (d as MoviesTrendingJson).movies ?? [],
  },
  "tv-trending": {
    title: "Trending TV Shows", endpoint: "/api/movies/trending", kind: "movie", mediaType: "tv",
    pickMovies: (d) => (d as MoviesTrendingJson).tv ?? [],
  },
  "movies-top": {
    title: "Top Rated Movies", endpoint: "/api/movies/top-rated", kind: "movie", mediaType: "movie", showScore: true,
    pickMovies: (d) => (d as MoviesTopJson).movies?.results ?? [],
  },
  "tv-top": {
    title: "Top Rated TV Shows", endpoint: "/api/movies/top-rated", kind: "movie", mediaType: "tv", showScore: true,
    pickMovies: (d) => (d as MoviesTopJson).tv?.results ?? [],
  },
};

const GRID = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4";

export default function BrowsePage() {
  const params = useParams();
  const router = useRouter();
  const cat = typeof params.cat === "string" ? params.cat : "";
  const meta = CATS[cat];
  const endpoint = meta?.endpoint ?? "";
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [movies, setMovies] = useState<MovieResult[] | null>(null);

  useEffect(() => {
    if (!endpoint || !meta) return;
    let cancelled = false;
    cachedFetch<unknown>(endpoint)
      .then((d) => {
        if (cancelled) return;
        if (meta.kind === "anime") {
          setItems(Array.isArray(d) ? (d as BrowseItem[]) : []);
        } else {
          try {
            setMovies(meta.pickMovies ? meta.pickMovies(d) : []);
          } catch {
            setMovies([]);
          }
        }
      })
      .catch(() => { if (!cancelled) { setItems([]); setMovies([]); } });
    return () => { cancelled = true; };
  }, [endpoint, meta]);

  // Invalid category -> existing 404 route. Called after hooks (throws).
  if (!meta) notFound();

  const list = meta.kind === "anime" ? items : movies;
  const count = list?.length;

  // Random pick from the loaded list (movie lists only — anime has the Nav shuffle).
  function shuffleList() {
    if (!movies || movies.length === 0) return;
    const m = movies[Math.floor(Math.random() * movies.length)];
    const type = (meta.mediaType ?? m.media_type) === "tv" ? "tv" : "movie";
    router.push(`/movies/${m.id}?type=${type}`);
  }

  return (
    <div className="max-w-7xl mx-auto page-top pb-6 space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/" className="text-text-muted hover:text-foreground transition-colors text-sm shrink-0">
          &larr; Home
        </Link>
        <h1 className="text-lg font-semibold">
          {meta.title}{" "}
          <span className="text-text-muted font-normal">({count ?? "…"})</span>
        </h1>
        {meta.note && <span className="text-xs text-text-secondary">{meta.note}</span>}
        {meta.kind === "movie" && (
          <button
            onClick={shuffleList}
            className="ml-auto rounded-chip border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-foreground btn-tap flex items-center gap-1.5"
            title="Random from this list"
            aria-label="Shuffle this list"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
            Shuffle
          </button>
        )}
      </div>
      {list === null && <CardGridSkeleton count={10} />}
      {list !== null && list.length === 0 && (
        <EmptyState
          icon={<Search className="h-8 w-8" aria-hidden />}
          title="No titles found"
          description="The catalogue is temporarily unavailable — try again later."
        />
      )}
      {meta.kind === "anime" && items !== null && items.length > 0 && (
        <div className={GRID}>
          {items.map((s, i) => (
            <AnimeCard
              key={s._id}
              id={s._id}
              title={s.name ?? s.title ?? ""}
              englishName={s.englishName}
              thumbnail={s.thumbnail}
              sub={s.availableEpisodes?.sub}
              dub={s.availableEpisodes?.dub}
              score={s.score ?? null}
              rank={i + 1}
            />
          ))}
        </div>
      )}
      {meta.kind === "movie" && movies !== null && movies.length > 0 && (
        <div className={GRID}>
          {movies.map((m, i) => (
            <MovieCard
              key={m.id}
              movie={{ ...m, media_type: meta.mediaType ?? m.media_type }}
              showScore={meta.showScore}
              rank={i + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
