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
      className="relative w-full h-[450px] mt-[30px] overflow-hidden select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { onMouseUp(); setHovered(false); }}
      onMouseEnter={() => setHovered(true)}
      style={{ cursor: "grab" }}
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
            {bg && (
              <Image src={bg} alt="" fill sizes="100vw" priority className="object-cover scale-105 brightness-[0.45]" />
            )}
          </div>
        );
      })}
      <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/50 to-background/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/30" />

      {/* Left arrow */}
      <button
        onClick={(e) => { e.stopPropagation(); prev(); }}
        className="absolute left-4 top-1/2 -translate-y-1/2 z-20 w-10 h-10 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/70 text-white/70 hover:text-white transition-[background-color,color,transform] duration-200 hover:scale-105"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>

      {/* Right arrow */}
      <button
        onClick={(e) => { e.stopPropagation(); next(); }}
        className="absolute right-4 top-1/2 -translate-y-1/2 z-20 w-10 h-10 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/70 text-white/70 hover:text-white transition-[background-color,color,transform] duration-200 hover:scale-105"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </button>

      {/* Content */}
      <div
        className={`absolute inset-0 z-10 flex items-center transition-[opacity,transform] duration-500 ease-out ${
          transitioning ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
        }`}
      >
        <div className="w-full max-w-7xl mx-auto px-8 md:px-16 flex items-center gap-10">
          {/* Poster */}
          {poster && (
            <div className="hidden md:block relative w-48 aspect-[3/4] rounded-lg overflow-hidden shadow-2xl shadow-black/60 shrink-0 group/poster">
            <Image
              src={poster}
              alt={title}
              fill
              sizes="(max-width: 768px) 45vw, 22vw"
              unoptimized
              className="object-cover transition-transform duration-500 ease-out group-hover/poster:scale-110"
            />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/poster:opacity-100 transition-opacity duration-500" />
              {item.genreNames.length > 0 && (
                <div className="absolute bottom-0 left-0 right-0 p-2.5 flex flex-wrap gap-1 opacity-0 group-hover/poster:opacity-100 transition-[opacity,transform] duration-500 translate-y-2 group-hover/poster:translate-y-0">
                  {item.genreNames.slice(0, 4).map((g) => (
                    <span key={g} className="text-[9px] font-medium bg-accent/90 text-white px-1.5 py-0.5 rounded-full">{g}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Text info */}
          <div className="flex-1 max-w-2xl">
            <span className="text-accent text-xs font-bold tracking-widest uppercase mb-2 block">
              Spotlight #{active + 1}
            </span>
            <h2 className="text-3xl md:text-5xl font-bold leading-tight mb-4 line-clamp-2">
              {title}
            </h2>
            <div className="flex items-center gap-2 mb-4 text-xs">
              {year && (
                <span className="bg-surface/80 px-2.5 py-1 rounded text-text-muted">{year}</span>
              )}
              <span className="bg-accent/20 text-accent px-2.5 py-1 rounded font-bold">HD</span>
            </div>
            {item.genreNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {item.genreNames.slice(0, 5).map((g) => (
                  <span key={g} className="text-[10px] bg-surface/60 px-2 py-0.5 rounded-full text-text-muted">{g}</span>
                ))}
              </div>
            )}
            {item.overview && (
              <p className="text-sm text-text-muted leading-relaxed line-clamp-3 mb-5 max-w-lg">
                {item.overview}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Link
                href={`/movies/${item.id}/watch?type=movie`}
                className="bg-accent hover:bg-accent-hover text-white px-7 py-2.5 rounded-lg text-sm font-semibold hover:scale-105 btn-tap"
              >
                Watch Now
              </Link>
              <Link
                href={`/movies/${item.id}?type=movie`}
                className="bg-surface/60 hover:bg-surface border border-border px-7 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-foreground hover:scale-105 btn-tap"
              >
                Detail
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Slide indicators */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-2">
        {movies.map((m, i) => (
          <button
            key={m.id}
            onClick={(e) => { e.stopPropagation(); changeSlide(() => i); }}
            className={`w-2 h-2 rounded-full transition-[width,background-color] duration-300 ${
              i === active ? "bg-accent w-6" : "bg-white/30 hover:bg-white/50"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
