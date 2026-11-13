"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { MovieResult } from "@/lib/movies";
import { cachedFetch } from "@/lib/cache";
import MovieCard from "./MovieCard";
import MovieSpotlightCarousel from "./MovieSpotlightCarousel";
import Rail from "./Rail";
import RailSkeleton from "./RailSkeleton";

interface TrendingData {
  movies: MovieResult[];
  tv: MovieResult[];
}

interface TopRatedData {
  movies: { results: MovieResult[] };
  tv: { results: MovieResult[] };
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <div className="absolute top-1.5 left-1.5 z-10">
      <span className="text-[10px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full">
        {String(rank).padStart(2, "0")}
      </span>
    </div>
  );
}

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

  return (
    <div className="space-y-10">
      {/* Spotlight carousel — same as anime section */}
      <MovieSpotlightCarousel />

      {/* Children (search bar, continue watching) rendered after spotlight */}
      {children && (
        <div className="space-y-10">
          {children}
        </div>
      )}

      <div className="py-8 space-y-10">
        {/* Trending Movies + TV */}
        {trendingLoading && (
          <>
            <RailSkeleton />
            <RailSkeleton />
          </>
        )}
        {!trendingLoading && trending?.movies && trending.movies.length > 0 && (
          <section>
            <Link href="/browse/movies-trending">
              <h2 className="text-lg font-semibold mb-4 section-title pl-10 pr-4 md:pl-10 md:pr-8 hover:text-accent transition-colors">Trending Movies</h2>
            </Link>
            <Rail itemCount={Math.min(trending.movies.length, 7)}>
              {trending.movies.slice(0, 7).map((m, i) => (
                <div key={m.id} className="relative flex-shrink-0 w-[180px]">
                  <RankBadge rank={i + 1} />
                  <MovieCard movie={m} />
                </div>
              ))}
            </Rail>
          </section>
        )}
        {!trendingLoading && trending?.tv && trending.tv.length > 0 && (
          <section>
            <Link href="/browse/tv-trending">
              <h2 className="text-lg font-semibold mb-4 section-title pl-10 pr-4 md:pl-10 md:pr-8 hover:text-accent transition-colors">Trending TV Shows</h2>
            </Link>
            <Rail itemCount={Math.min(trending.tv.length, 7)}>
              {trending.tv.slice(0, 7).map((m, i) => (
                <div key={m.id} className="relative flex-shrink-0 w-[180px]">
                  <RankBadge rank={i + 1} />
                  <MovieCard movie={{ ...m, media_type: "tv" }} />
                </div>
              ))}
            </Rail>
          </section>
        )}

        {/* Top Rated Movies + TV */}
        {topLoading && (
          <>
            <RailSkeleton />
            <RailSkeleton />
          </>
        )}
        {!topLoading && topRated?.movies?.results && topRated.movies.results.length > 0 && (
          <section>
            <Link href="/browse/movies-top">
              <h2 className="text-lg font-semibold mb-4 section-title pl-10 pr-4 md:pl-10 md:pr-8 hover:text-accent transition-colors">Top Rated Movies</h2>
            </Link>
            <Rail itemCount={Math.min(topRated.movies.results.length, 7)}>
              {topRated.movies.results.slice(0, 7).map((m) => (
                <div key={m.id} className="flex-shrink-0 w-[180px]">
                  <MovieCard movie={{ ...m, media_type: "movie" }} showScore />
                </div>
              ))}
            </Rail>
          </section>
        )}
        {!topLoading && topRated?.tv?.results && topRated.tv.results.length > 0 && (
          <section>
            <Link href="/browse/tv-top">
              <h2 className="text-lg font-semibold mb-4 section-title pl-10 pr-4 md:pl-10 md:pr-8 hover:text-accent transition-colors">Top Rated TV Shows</h2>
            </Link>
            <Rail itemCount={Math.min(topRated.tv.results.length, 7)}>
              {topRated.tv.results.slice(0, 7).map((m) => (
                <div key={m.id} className="flex-shrink-0 w-[180px]">
                  <MovieCard movie={{ ...m, media_type: "tv" }} showScore />
                </div>
              ))}
            </Rail>
          </section>
        )}
      </div>
    </div>
  );
}
