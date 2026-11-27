"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { MovieResult } from "@/lib/movies";
import { cachedFetch } from "@/lib/cache";
import MovieCard from "./MovieCard";
import MovieSpotlightCarousel from "./MovieSpotlightCarousel";
import Rail from "./Rail";
import RailSkeleton from "./RailSkeleton";
import SectionHeader from "./SectionHeader";

interface TrendingData {
  movies: MovieResult[];
  tv: MovieResult[];
}

interface TopRatedData {
  movies: { results: MovieResult[] };
  tv: { results: MovieResult[] };
}

const RAIL_CARD = "rail-card";

export default function MoviesSection({ children }: { children?: ReactNode }) {
  const [trending, setTrending] = useState<TrendingData | null>(null);
  const [topRated, setTopRated] = useState<TopRatedData | null>(null);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [topLoading, setTopLoading] = useState(true);

  useEffect(() => {
    cachedFetch<TrendingData>("/api/movies/trending")
      .then((data) => { if (data) setTrending(data); })
      .catch(() => {})
      .finally(() => setTrendingLoading(false));
    cachedFetch<TopRatedData>("/api/movies/top-rated")
      .then((data) => { if (data) setTopRated(data); })
      .catch(() => {})
      .finally(() => setTopLoading(false));
  }, []);

  const rail = (items: MovieResult[], mediaType: "movie" | "tv", showScore?: boolean) => (
    <Rail itemCount={Math.min(items.length, 8)}>
      {items.slice(0, 8).map((m, i) => (
        <MovieCard
          key={m.id}
          movie={{ ...m, media_type: mediaType }}
          showScore={showScore}
          rank={showScore ? undefined : i + 1}
          className={RAIL_CARD}
        />
      ))}
    </Rail>
  );

  return (
    <div className="pb-16">
      <MovieSpotlightCarousel />

      <div className="mx-auto w-full space-y-14 page-gutter">
        {children}

        {trendingLoading && (
          <>
            <RailSkeleton />
            <RailSkeleton />
          </>
        )}

        {!trendingLoading && trending?.movies && trending.movies.length > 0 && (
          <section>
            <SectionHeader title="Trending Movies" href="/browse/movies-trending" />
            {rail(trending.movies, "movie")}
          </section>
        )}
        {!trendingLoading && trending?.tv && trending.tv.length > 0 && (
          <section>
            <SectionHeader title="Trending TV Shows" href="/browse/tv-trending" />
            {rail(trending.tv, "tv")}
          </section>
        )}

        {topLoading && (
          <>
            <RailSkeleton />
            <RailSkeleton />
          </>
        )}
        {!topLoading && topRated?.movies?.results && topRated.movies.results.length > 0 && (
          <section>
            <SectionHeader title="Top Rated Movies" href="/browse/movies-top" />
            {rail(topRated.movies.results, "movie", true)}
          </section>
        )}
        {!topLoading && topRated?.tv?.results && topRated.tv.results.length > 0 && (
          <section>
            <SectionHeader title="Top Rated TV Shows" href="/browse/tv-top" />
            {rail(topRated.tv.results, "tv", true)}
          </section>
        )}
      </div>
    </div>
  );
}
