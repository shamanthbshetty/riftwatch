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
      className="relative w-full h-[450px] mt-[30px] select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { onMouseUp(); setHovered(false); }}
      onMouseEnter={() => setHovered(true)}
      style={{ cursor: "grab" }}
    >
      {/* Background image — crossfade between slides */}
      <div className="absolute inset-0 overflow-hidden">
        {shows.map((s, i) => (
          <div
            key={s._id}
            className="absolute inset-0 transition-opacity duration-700 ease-in-out"
            style={{ opacity: i === active ? 1 : 0 }}
          >
              {s.thumbnail && <Image
                src={s.thumbnail}
                alt=""
                fill
                sizes="100vw"
                priority
                unoptimized
                className="object-cover scale-105 brightness-[0.45]"
              />}
          </div>
        ))}
      </div>
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
        <div className="w-full max-w-7xl mx-auto px-4 md:px-8 flex items-center gap-8">
          {/* Poster thumbnail with genre tags on hover */}
          <div className="hidden md:block relative w-40 aspect-[3/4] rounded-lg overflow-hidden shadow-2xl shadow-black/60 shrink-0 group/poster">
              {item.thumbnail && <Image
                src={item.thumbnail}
                alt={item.name}
                fill
                sizes="(max-width: 768px) 45vw, 22vw"
                unoptimized
                className="object-cover transition-transform duration-500 ease-out group-hover/poster:scale-110"
              />}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/poster:opacity-100 transition-opacity duration-500" />
            {/* Genre tags on poster hover */}
            {item.genres.length > 0 && (
              <div className="absolute bottom-0 left-0 right-0 p-2.5 flex flex-wrap gap-1 opacity-0 group-hover/poster:opacity-100 transition-[opacity,transform] duration-500 translate-y-2 group-hover/poster:translate-y-0">
                {item.genres.slice(0, 4).map((g) => (
                  <span key={g} className="text-[9px] font-medium bg-accent/90 text-white px-1.5 py-0.5 rounded-full">{g}</span>
                ))}
              </div>
            )}
          </div>

          {/* Text info */}
          <div className="flex-1 max-w-2xl">
            <span className="text-accent text-xs font-bold tracking-widest uppercase mb-2 block">
              Spotlight #{active + 1}
            </span>
            <h2 className="text-3xl md:text-5xl font-bold leading-tight mb-4 line-clamp-2">
              {item.englishName || item.name}
            </h2>
            <div className="flex items-center gap-2 mb-4 text-xs">
              {item.status === "NOT_YET_RELEASED" ? (
                <span className="bg-amber-500/20 text-amber-500 px-2.5 py-1 rounded text-xs font-semibold">Upcoming</span>
              ) : (
                item.status && (
                  <span className="bg-surface/80 px-2.5 py-1 rounded text-text-muted">{item.status}</span>
                )
              )}
              {item.availableEpisodes?.sub > 0 && (
                <span className="bg-badge-sub/20 text-badge-sub px-2.5 py-1 rounded font-semibold">SUB {item.availableEpisodes.sub}</span>
              )}
              {item.availableEpisodes?.dub > 0 && (
                <span className="bg-badge-dub/20 text-badge-dub px-2.5 py-1 rounded font-semibold">DUB {item.availableEpisodes.dub}</span>
              )}
              <span className="bg-accent/20 text-accent px-2.5 py-1 rounded font-bold">HD</span>
            </div>
            {item.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {item.genres.slice(0, 5).map((g) => (
                  <span key={g} className="text-[10px] bg-surface/60 px-2 py-0.5 rounded-full text-text-muted">{g}</span>
                ))}
              </div>
            )}
            {item.description && (
              <p className="text-sm text-text-muted leading-relaxed line-clamp-3 mb-5 max-w-lg">
                {item.description}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Link
                href={`/watch/${item._id}?ep=1&mode=sub${item.englishName || item.name ? `&title=${encodeURIComponent(item.englishName || item.name)}` : ""}`}
                className="bg-accent hover:bg-accent-hover text-white px-7 py-2.5 rounded-lg text-sm font-semibold hover:scale-105 btn-tap"
              >
                Watch Now
              </Link>
              <Link
                href={`/anime/${item._id}`}
                className="bg-surface/60 hover:bg-surface border border-border px-7 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-foreground hover:scale-105 btn-tap"
              >
                Detail
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Slide indicators — bottom dots */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-2">
        {shows.map((_, i) => (
          <button
            key={i}
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
