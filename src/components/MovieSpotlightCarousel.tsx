"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import type { MovieResult } from "@/lib/movies";
import { posterUrl } from "@/lib/movies";
import { cachedFetch } from "@/lib/cache";

const TMDB_IMG = "https://image.tmdb.org/t/p";

interface SpotlightMovie extends MovieResult {
  genreNames: string[];
}

const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

export default function MovieSpotlightCarousel() {
  const [movies, setMovies] = useState<SpotlightMovie[]>([]);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const dragRef = useRef({ startX: 0, dragging: false });

  useEffect(() => {
    cachedFetch<{ movies: MovieResult[] }>("/api/movies/trending")
      .then((data) => {
        if (!data?.movies) return;
        const top = data.movies.slice(0, 7).map((m) => ({
          ...m,
          genreNames: (m.genre_ids ?? []).map((id) => GENRE_MAP[id]).filter(Boolean),
        }));
        setMovies(top);
      })
      .catch(() => {});
  }, []);

  // Rapid clicks must not queue multiple slide jumps, and unmounting inside
  // the 200 ms window must not setState on an unmounted component.
  const changeSlideRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(changeSlideRef.current), []);
  const changeSlide = useCallback((fn: (i: number, len: number) => number) => {
    clearTimeout(changeSlideRef.current);
    setTransitioning(true);
    changeSlideRef.current = setTimeout(() => {
      setActive((i) => fn(i, movies.length));
      setTransitioning(false);
    }, 200);
  }, [movies.length]);

  const prev = useCallback(() => {
    if (movies.length === 0) return;
    changeSlide((i, len) => (i - 1 + len) % len);
  }, [movies.length, changeSlide]);

  const next = useCallback(() => {
    if (movies.length === 0) return;
    changeSlide((i, len) => (i + 1) % len);
  }, [movies.length, changeSlide]);

  useEffect(() => {
    if (movies.length === 0 || hovered) return;
    const timer = setInterval(() => next(), 6000);
    return () => clearInterval(timer);
  }, [movies.length, hovered, next]);

  useEffect(() => {
    if (!hovered) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered, prev, next]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, dragging: true };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    if (Math.abs(dx) > 80) {
      if (dx < 0) next();
      else prev();
      dragRef.current.startX = e.clientX;
    }
  }, [next, prev]);

  const onMouseUp = useCallback(() => {
    dragRef.current.dragging = false;
  }, []);

  if (movies.length === 0) return null;

  const item = movies[active];
  const title = item.title || item.name || "Untitled";
  const year = item.release_date ? new Date(item.release_date).getFullYear() : null;
  const poster = posterUrl(item.poster_path, "w500");

  return (
    <div
      className="relative h-[520px] w-full select-none overflow-hidden"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { onMouseUp(); setHovered(false); }}
      onMouseEnter={() => setHovered(true)}
    >
      {/* Background crossfade */}
      {movies.map((m) => {
        const bg = m.backdrop_path ? `${TMDB_IMG}/w1280${m.backdrop_path}` : null;
        return (
          <div
            key={m.id}
            className="absolute inset-0 transition-opacity duration-700 ease-in-out"
            style={{ opacity: m.id === item.id ? 1 : 0 }}
          >
            {bg && <Image src={bg} alt="" fill sizes="100vw" priority={m.id === movies[0]?.id} className="scale-105 object-cover brightness-[0.42]" />}
          </div>
        );
      })}
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/55 to-background/10" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/40" />

      {/* Left arrow */}
      <button
        aria-label="Previous spotlight"
        onClick={(e) => { e.stopPropagation(); prev(); }}
        className="absolute left-4 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/70 opacity-0 transition-[opacity,background-color,color] hover:bg-black/70 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 md:opacity-100"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>

      {/* Right arrow */}
      <button
        aria-label="Next spotlight"
        onClick={(e) => { e.stopPropagation(); next(); }}
        className="absolute right-4 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/70 opacity-0 transition-[opacity,background-color,color] hover:bg-black/70 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 md:opacity-100"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </button>

      {/* Content */}
      <div
        className={`absolute inset-0 z-10 flex items-end pb-14 transition-[opacity,transform] duration-500 ease-out md:items-center md:pb-0 ${
          transitioning ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <div className="mx-auto flex w-full max-w-7xl items-end gap-8 px-4 md:px-6">
          {/* Poster */}
          {poster && (
            <div className="group/poster relative hidden aspect-[3/4] w-36 shrink-0 overflow-hidden rounded-surface shadow-2xl shadow-black/60 md:block">
              <Image
                src={poster}
                alt={title}
                fill
                sizes="144px"
                unoptimized
                className="object-cover"
              />
              {item.genreNames.length > 0 && (
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 p-2.5 opacity-0 transition-opacity duration-300 group-hover/poster:opacity-100">
                  {item.genreNames.slice(0, 4).map((g) => (
                    <span key={g} className="rounded-chip bg-black/60 px-1.5 py-0.5 text-2xs font-medium text-white/85 backdrop-blur-sm">{g}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Text info */}
          <div className="max-w-xl flex-1">
            <span className="mb-2 block text-2xs font-semibold uppercase tracking-[0.18em] text-accent">
              Featured
            </span>
            <h2 className="mb-3 line-clamp-2 text-3xl font-semibold leading-[1.1] tracking-tight md:text-4xl">
              {title}
            </h2>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
              {year && <span>{year}</span>}
              {item.genreNames.length > 0 && <span className="truncate">{item.genreNames.slice(0, 3).join(" · ")}</span>}
            </div>
            {item.overview && (
              <p className="mb-4 line-clamp-3 max-w-lg text-sm leading-relaxed text-text-muted">
                {item.overview}
              </p>
            )}
            <div className="flex items-center gap-2.5">
              <Link
                href={`/movies/${item.id}/watch?type=movie`}
                className="inline-flex items-center gap-2 rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover btn-tap"
              >
                <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                Watch now
              </Link>
              <Link
                href={`/movies/${item.id}?type=movie`}
                className="rounded-control border border-white/20 bg-white/5 px-5 py-2.5 text-sm font-medium text-white/85 backdrop-blur-sm transition-colors hover:bg-white/10 hover:text-white btn-tap"
              >
                Details
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Slide indicators */}
      <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
        {movies.map((m, i) => (
          <button
            key={m.id}
            aria-label={`Go to slide ${i + 1}`}
            onClick={(e) => { e.stopPropagation(); changeSlide(() => i); }}
            className={`h-1 rounded-full transition-[width,background-color] duration-300 ${
              i === active ? "w-6 bg-accent" : "w-2 bg-white/30 hover:bg-white/50"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
