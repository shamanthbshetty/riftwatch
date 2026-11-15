"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { cachedFetch } from "@/lib/cache";

interface SpotlightItem {
  _id: string;
  name: string;
  englishName?: string;
  thumbnail: string;
  description: string;
  genres: string[];
  status: string;
  availableEpisodes: { sub: number; dub: number };
}

export default function SpotlightCarousel() {
  const [shows, setShows] = useState<SpotlightItem[]>([]);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const dragRef = useRef({ startX: 0, dragging: false });

  useEffect(() => {
    cachedFetch<SpotlightItem[]>("/api/spotlight")
      .then((data) => {
        if (Array.isArray(data)) setShows(data.slice(0, 7));
      })
      .catch(() => {});
  }, []);

  // Rapid clicks must not queue multiple slide jumps (three fast clicks used
  // to move three positions and flicker `transitioning`), and unmounting inside
  // the 200 ms window must not setState on an unmounted component.
  const changeSlideRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(changeSlideRef.current), []);
  const changeSlide = useCallback((fn: (i: number, len: number) => number) => {
    clearTimeout(changeSlideRef.current);
    setTransitioning(true);
    changeSlideRef.current = setTimeout(() => {
      setActive((i) => fn(i, shows.length));
      setTransitioning(false);
    }, 200);
  }, [shows.length]);

  const prev = useCallback(() => {
    if (shows.length === 0) return;
    changeSlide((i, len) => (i - 1 + len) % len);
  }, [shows.length, changeSlide]);

  const next = useCallback(() => {
    if (shows.length === 0) return;
    changeSlide((i, len) => (i + 1) % len);
  }, [shows.length, changeSlide]);

  // Auto-rotate
  useEffect(() => {
    if (shows.length === 0 || hovered) return;
    const timer = setInterval(() => next(), 6000);
    return () => clearInterval(timer);
  }, [shows.length, hovered, next]);

  // Keyboard navigation when hovered
  useEffect(() => {
    if (!hovered) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered, prev, next]);

  // Mouse drag to cycle
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

  if (shows.length === 0) return null;

  const item = shows[active];

  return (
    <div
      className="relative h-[520px] w-full select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { onMouseUp(); setHovered(false); }}
      onMouseEnter={() => setHovered(true)}
    >
      {/* Background image — crossfade between slides */}
      <div className="absolute inset-0 overflow-hidden">
        {shows.map((s, i) => (
          <div
            key={s._id}
            className="absolute inset-0 transition-opacity duration-700 ease-in-out"
            style={{ opacity: i === active ? 1 : 0 }}
          >
            {s.thumbnail && (
              <Image
                src={s.thumbnail}
                alt=""
                fill
                sizes="100vw"
                priority={i === 0}
                unoptimized
                className="scale-105 object-cover brightness-[0.42]"
              />
            )}
          </div>
        ))}
      </div>
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
          {/* Poster thumbnail with genre tags on hover */}
          <div className="group/poster relative hidden aspect-[3/4] w-36 shrink-0 overflow-hidden rounded-surface shadow-2xl shadow-black/60 md:block">
            {item.thumbnail && (
              <Image
                src={item.thumbnail}
                alt={item.name}
                fill
                sizes="144px"
                unoptimized
                className="object-cover"
              />
            )}
            {item.genres.length > 0 && (
              <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 p-2.5 opacity-0 transition-opacity duration-300 group-hover/poster:opacity-100">
                {item.genres.slice(0, 4).map((g) => (
                  <span key={g} className="rounded-chip bg-black/60 px-1.5 py-0.5 text-2xs font-medium text-white/85 backdrop-blur-sm">{g}</span>
                ))}
              </div>
            )}
          </div>

          {/* Text info */}
          <div className="max-w-xl flex-1">
            <span className="mb-2 block text-2xs font-semibold uppercase tracking-[0.18em] text-accent">
              Featured
            </span>
            <h2 className="mb-3 line-clamp-2 text-3xl font-semibold leading-[1.1] tracking-tight md:text-4xl">
              {item.englishName || item.name}
            </h2>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
              {item.status === "NOT_YET_RELEASED" ? (
                <span className="font-semibold text-amber-500">Upcoming</span>
              ) : (
                item.status && <span>{item.status}</span>
              )}
              {item.availableEpisodes?.sub > 0 && <span className="text-rose-400">{item.availableEpisodes.sub} SUB</span>}
              {item.availableEpisodes?.dub > 0 && <span className="text-amber-400">{item.availableEpisodes.dub} DUB</span>}
              {item.genres.length > 0 && <span className="truncate">{item.genres.slice(0, 3).join(" · ")}</span>}
            </div>
            {item.description && (
              <p className="mb-4 line-clamp-3 max-w-lg text-sm leading-relaxed text-text-muted">
                {item.description}
              </p>
            )}
            <div className="flex items-center gap-2.5">
              <Link
                href={`/watch/${item._id}?ep=1&mode=sub${item.englishName || item.name ? `&title=${encodeURIComponent(item.englishName || item.name)}` : ""}`}
                className="inline-flex items-center gap-2 rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover btn-tap"
              >
                <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                Watch now
              </Link>
              <Link
                href={`/anime/${item._id}`}
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
        {shows.map((_, i) => (
          <button
            key={i}
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
