"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AnimeCard from "@/components/AnimeCard";
import SpotlightCarousel from "@/components/SpotlightCarousel";
import TrendingCarousel from "@/components/TrendingCarousel";
import TopRated from "@/components/TopRated";
import MostPopular from "@/components/MostPopular";
import ContinueWatching from "@/components/ContinueWatching";
import ScheduleSection from "@/components/ScheduleSection";
import MoviesSection from "@/components/MoviesSection";
import ContinueWatchingMovies from "@/components/ContinueWatchingMovies";
import MovieCard from "@/components/MovieCard";
import type { SearchResult } from "@/lib/allanime";
import type { MovieResult } from "@/lib/movies";

const EMPTY_ANIME: SearchResult[] = [];
const EMPTY_MOVIES: MovieResult[] = [];

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
        <div className="max-w-7xl mx-auto pt-[50px] pb-6 space-y-6">
          <h1 className="text-lg font-semibold mt-4">
            Movie results for &ldquo;{q}&rdquo; <span className="text-text-muted font-normal">({movieResults.length})</span>
          </h1>
          {movieLoading && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="aspect-[3/4] rounded-lg bg-surface skeleton" />
              ))}
            </div>
          )}
          {!movieLoading && movieResults.length === 0 && (
            <div className="text-center py-16 space-y-3">
              <div className="text-4xl mb-4">
                <svg className="w-12 h-12 mx-auto text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                </svg>
              </div>
              <p className="text-text-muted font-medium">No movies found for &ldquo;{q}&rdquo;</p>
              <p className="text-text-secondary text-sm">Try different keywords or check your spelling</p>
            </div>
          )}
          {!movieLoading && movieResults.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {movieResults.map((m) => (
                <MovieCard key={m.id} movie={m} />
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="max-w-7xl mx-auto pt-[50px] pb-6 space-y-6">
        <h1 className="text-lg font-semibold mt-4">
          Search results for &ldquo;{q}&rdquo; <span className="text-text-muted font-normal">({animeResults.length})</span>
        </h1>
        {animeLoading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] rounded-md bg-surface animate-pulse" />
            ))}
          </div>
        )}
        {!animeLoading && animeResults.length === 0 && (
          <div className="text-center py-16 space-y-3">
            <div className="text-4xl mb-4">
              <svg className="w-12 h-12 mx-auto text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <p className="text-text-muted font-medium">No anime found for &ldquo;{q}&rdquo;</p>
            <p className="text-text-secondary text-sm">Try different keywords or check your spelling</p>
          </div>
        )}
        {!animeLoading && animeResults.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
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
    <div className="space-y-0">
      <SpotlightCarousel />

      <div className="py-8 space-y-10">
        <ContinueWatching />
      </div>

      <div className="py-8 space-y-10">
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
    <Suspense fallback={<div className="max-w-7xl mx-auto py-16 text-text-muted text-center">Loading...</div>}>
      <HomeContent />
    </Suspense>
  );
}
