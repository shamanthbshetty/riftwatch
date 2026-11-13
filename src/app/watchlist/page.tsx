"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AnimeCard from "@/components/AnimeCard";
import MovieCard from "@/components/MovieCard";
import {
  removeFromWatchlist,
  removeFromMovieWatchlist,
  setWatchlistStatus,
  setMovieWatchlistStatus,
  type WatchStatus,
} from "@/lib/storage";
import { useWatchlistItems, useMovieWatchlistItems } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import { STATUS_ORDER, STATUS_LABELS, STATUS_BADGE_TEXT, STATUS_MENU_CLASS, StatusMenuList } from "@/components/WatchlistStatusButton";

const FILTERS: ("all" | WatchStatus)[] = ["all", ...STATUS_ORDER];

function StatusMenu({ current, onSelect }: { current: WatchStatus; onSelect: (s: WatchStatus) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="absolute top-1.5 left-1.5 z-30">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm hover:scale-105 transition-transform ${STATUS_BADGE_TEXT[current]}`}
        title="Change status"
      >
        {STATUS_LABELS[current]}
      </button>
      {open && (
        <div className={`absolute left-0 top-full mt-1 w-40 z-40 ${STATUS_MENU_CLASS} origin-top-left`}>
          <StatusMenuList current={current} onPick={(s) => { onSelect(s); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function filterByStatus<T extends { status?: WatchStatus }>(list: T[], filter: "all" | WatchStatus): T[] {
  return filter === "all" ? list : list.filter((i) => (i.status ?? "watching") === filter);
}

function WatchlistContent() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "anime";
  const isMovies = tab === "movies";
  const animeItems = useWatchlistItems();
  const movieItems = useMovieWatchlistItems();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"all" | WatchStatus>("all");
  // Right-click context menu: viewport position + the card it targets.
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; movie: boolean; status: WatchStatus } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctx) return;
    // Close on outside mousedown only — a mousedown on the menu itself must
    // survive to become the click that picks a status.
    function onDocClick(e: MouseEvent) {
      if (ctxRef.current && ctxRef.current.contains(e.target as Node)) return;
      setCtx(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setCtx(null); }
    function onScroll() { setCtx(null); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ctx]);

  function openCtx(e: React.MouseEvent, id: string, movie: boolean, status: WatchStatus) {
    e.preventDefault();
    setCtx({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 170)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 250)),
      id,
      movie,
      status,
    });
  }

  function removeAnime(id: string) {
    removeFromWatchlist(id);
    toast("Removed from watchlist");
  }

  function removeMovie(id: string) {
    removeFromMovieWatchlist(id);
    toast("Removed from watchlist");
  }

  function changeAnimeStatus(id: string, status: WatchStatus) {
    setWatchlistStatus(id, status);
    toast(`Marked as ${STATUS_LABELS[status]}`);
  }

  function changeMovieStatus(id: string, status: WatchStatus) {
    setMovieWatchlistStatus(id, status);
    toast(`Marked as ${STATUS_LABELS[status]}`);
  }

  const items = isMovies ? movieItems : animeItems;

  const counts = useMemo(() => {
    const c = { all: items.length } as Record<"all" | WatchStatus, number>;
    for (const s of STATUS_ORDER) c[s] = 0;
    for (const i of items) c[i.status ?? "watching"]++;
    return c;
  }, [items]);

  const shownAnime = useMemo(() => filterByStatus(animeItems, statusFilter), [animeItems, statusFilter]);
  const shownMovies = useMemo(() => filterByStatus(movieItems, statusFilter), [movieItems, statusFilter]);

  return (
    <div className="max-w-7xl mx-auto pt-[84px] pb-6 space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">My Watchlist</h1>
        <span className="text-xs px-2 py-0.5 rounded bg-surface text-text-muted uppercase">{isMovies ? "Movies" : "Anime"}</span>
      </div>
      {items.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                statusFilter === s
                  ? "bg-accent text-white border-accent"
                  : "bg-surface text-text-muted border-border hover:text-text"
              }`}
            >
              {s === "all" ? "All" : STATUS_LABELS[s]} ({counts[s]})
            </button>
          ))}
        </div>
      )}
      {items.length === 0 && (
        <div className="text-center py-16 space-y-3">
          <div className="mb-4">
            <svg className="w-16 h-16 mx-auto text-text-secondary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </div>
          <p className="text-text-muted font-medium">Your watchlist is empty</p>
          <p className="text-text-secondary text-sm">
            {isMovies ? "Search for movies to add them here." : "Search for anime to add them here."}
          </p>
        </div>
      )}
      {items.length > 0 && (isMovies ? shownMovies : shownAnime).length === 0 && (
        <p className="text-center py-12 text-text-muted text-sm">Nothing with this status yet.</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {isMovies
          ? shownMovies.map((item) => (
              <div
                key={item.id}
                className="relative group"
                onContextMenu={(e) => openCtx(e, item.id, true, item.status ?? "watching")}
              >
                <MovieCard
                  movie={{
                    id: Number(item.id),
                    title: item.title,
                    name: item.title,
                    overview: "",
                    poster_path: item.poster,
                    backdrop_path: null,
                    vote_average: 0,
                    media_type: item.type,
                  }}
                  actions={
                    <>
                      <StatusMenu current={item.status ?? "watching"} onSelect={(s) => changeMovieStatus(item.id, s)} />
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeMovie(item.id); }}
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-surface/90 border border-border flex items-center justify-center text-text-muted hover:text-red-400 hover:border-red-400/50 opacity-0 group-hover:opacity-100 transition-[opacity,color,border-color] z-30"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  }
                />
              </div>
            ))
          : shownAnime.map((item) => (
              <div
                key={item.id}
                className="relative group"
                onContextMenu={(e) => openCtx(e, item.id, false, item.status ?? "watching")}
              >
                <AnimeCard
                  id={item.id}
                  title={item.title}
                  englishName={item.englishName}
                  thumbnail={item.thumbnail}
                  actions={
                    <>
                      <StatusMenu current={item.status ?? "watching"} onSelect={(s) => changeAnimeStatus(item.id, s)} />
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeAnime(item.id); }}
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-surface/90 border border-border flex items-center justify-center text-text-muted hover:text-red-400 hover:border-red-400/50 opacity-0 group-hover:opacity-100 transition-[opacity,color,border-color] z-30"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  }
                />
              </div>
            ))}
      </div>
      {ctx && (
        <div
          ref={ctxRef}
          className={`fixed z-[200] w-40 ${STATUS_MENU_CLASS} origin-top-left`}
          style={{ left: ctx.x, top: ctx.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <StatusMenuList
            current={ctx.status}
            onPick={(s) => {
              if (ctx.movie) changeMovieStatus(ctx.id, s);
              else changeAnimeStatus(ctx.id, s);
              setCtx(null);
            }}
            onRemove={() => {
              if (ctx.movie) removeMovie(ctx.id);
              else removeAnime(ctx.id);
              setCtx(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function WatchlistPage() {
  return (
      <Suspense fallback={<div className="max-w-7xl mx-auto py-8 text-text-muted">Loading...</div>}>
      <WatchlistContent />
    </Suspense>
  );
}
