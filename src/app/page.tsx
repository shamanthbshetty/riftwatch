"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import AnimeCard from "@/components/AnimeCard";
import SpotlightCarousel from "@/components/SpotlightCarousel";
import TrendingCarousel from "@/components/TrendingCarousel";
import TopRated from "@/components/TopRated";
import MostPopular from "@/components/MostPopular";
import ContinueWatching from "@/components/ContinueWatching";
import BecauseYouWatched from "@/components/BecauseYouWatched";
import ScheduleSection from "@/components/ScheduleSection";
import MoviesSection from "@/components/MoviesSection";
import ContinueWatchingMovies from "@/components/ContinueWatchingMovies";
import MovieCard from "@/components/MovieCard";
import EmptyState, { CardGridSkeleton } from "@/components/Skeleton";
import type { SearchResult } from "@/lib/allanime";
import type { MovieResult } from "@/lib/movies";

const EMPTY_ANIME: SearchResult[] = [];
const EMPTY_MOVIES: MovieResult[] = [];

const PAGE = "mx-auto w-full page-gutter";
const GRID = "grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";

function HomeContent() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const tab = searchParams.get("tab") ?? "anime";
  const isMovies = tab === "movies";

  // Search results are tagged with the query that produced them, so typing a new
  // query shows a loading state instead of the previous query's results, and no
  // effect has to synchronously clear state.
  const [anime, setAnime] = useState<{ q: string; results: SearchResult[] } | null>(null);
  const [movie, setMovie] = useState<{ q: string; results: MovieResult[] } | null>(null);

  const animeResults = anime?.q === q ? anime.results : EMPTY_ANIME;
  const movieResults = movie?.q === q ? movie.results : EMPTY_MOVIES;
  const animeLoading = Boolean(q) && anime?.q !== q;
  const movieLoading = Boolean(q) && movie?.q !== q;

  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    if (isMovies) {
      fetch(`/api/movies/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data) => { if (!cancelled) setMovie({ q, results: data.results ?? [] }); })
        .catch(() => { if (!cancelled) setMovie({ q, results: [] }); });
    } else {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data) => { if (!cancelled) setAnime({ q, results: Array.isArray(data) ? data : [] }); })
        .catch(() => { if (!cancelled) setAnime({ q, results: [] }); });
    }
    return () => {
      cancelled = true;
    };
  }, [q, isMovies]);

  if (q) {
    if (isMovies) {
      return (
        <div className={`${PAGE} page-top space-y-5 pb-10`}>
          <h1 className="text-xl font-semibold tracking-tight">
            {movieLoading ? "Searching…" : `Results for “${q}”`}
            {!movieLoading && <span className="ml-2 text-sm font-normal text-text-secondary">{movieResults.length} titles</span>}
          </h1>
          {movieLoading && <CardGridSkeleton />}
          {!movieLoading && movieResults.length === 0 && (
            <EmptyState
              icon={<Search className="h-8 w-8" aria-hidden />}
              title={`No titles found for “${q}”`}
              description="Try a different spelling, or search for the original Japanese title."
            />
          )}
          {!movieLoading && movieResults.length > 0 && (
            <div className={GRID}>
              {movieResults.map((m) => (
                <MovieCard key={m.id} movie={m} />
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={`${PAGE} page-top space-y-5 pb-10`}>
        <h1 className="text-xl font-semibold tracking-tight">
          {animeLoading ? "Searching…" : `Results for “${q}”`}
          {!animeLoading && <span className="ml-2 text-sm font-normal text-text-secondary">{animeResults.length} titles</span>}
        </h1>
        {animeLoading && <CardGridSkeleton />}
        {!animeLoading && animeResults.length === 0 && (
          <EmptyState
            icon={<Search className="h-8 w-8" aria-hidden />}
            title={`No anime found for “${q}”`}
            description="Try a different spelling, or search for the original Japanese title."
          />
        )}
        {!animeLoading && animeResults.length > 0 && (
          <div className={GRID}>
            {animeResults.map((r) => (
              <AnimeCard
                key={r._id}
                id={r._id}
                title={r.name}
                englishName={r.englishName}
                thumbnail={r.thumbnail}
                sub={r.availableEpisodes?.sub}
                dub={r.availableEpisodes?.dub}
                status={r.status}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isMovies) {
    return (
      <MoviesSection>
        <ContinueWatchingMovies />
      </MoviesSection>
    );
  }

  return (
    <div className="pb-16">
      <SpotlightCarousel />

      <div className={`${PAGE} relative z-10 -mt-8 space-y-14`}>
        <ContinueWatching />
        <BecauseYouWatched />

        <TrendingCarousel />
        <MostPopular />
        <TopRated />
        <ScheduleSection />
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="mx-auto px-4 py-24 text-center text-sm text-text-muted">Loading…</div>}>
      <HomeContent />
    </Suspense>
  );
}
