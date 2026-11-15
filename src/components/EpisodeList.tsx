"use client";

import { useState, useMemo } from "react";

const PAGE_SIZE = 100;

interface EpisodeListProps {
  episodes: number[];
  mode: "sub" | "dub";
  titles?: Record<string, string>;
  currentEp?: number;
  watchedUpTo?: number;
  onSelect: (ep: number) => void;
}

export default function EpisodeList({ episodes, mode, titles, currentEp, watchedUpTo, onSelect }: EpisodeListProps) {
  const [jump, setJump] = useState("");
  const [unwatchedOnly, setUnwatchedOnly] = useState(false);

  // Filter first — pagination, "jump" and counts all operate on the filtered
  // list so the toolbar never points at an episode the grid can't show.
  const filtered = useMemo(() => {
    if (!unwatchedOnly) return episodes;
    return episodes.filter((ep) => watchedUpTo == null || ep > watchedUpTo || ep === currentEp);
  }, [episodes, unwatchedOnly, watchedUpTo, currentEp]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const initialPage = useMemo(() => {
    if (!currentEp || totalPages <= 1) return 0;
    return Math.max(0, Math.floor(filtered.indexOf(currentEp) / PAGE_SIZE));
  }, [currentEp, filtered, totalPages]);

  const [page, setPage] = useState(Math.max(0, initialPage));
  const showInline = filtered.length <= 24;

  function jumpToEp(e: React.FormEvent) {
    e.preventDefault();
    const n = Number.parseInt(jump, 10);
    if (!Number.isFinite(n) || !episodes.includes(n)) return;
    // Reveal the target: drop the filter if it hides the episode, then open
    // its page and play it.
    if (!filtered.includes(n)) setUnwatchedOnly(false);
    setPage(Math.floor(episodes.indexOf(n) / PAGE_SIZE));
    setJump("");
    onSelect(n);
  }

  if (episodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-text-muted">
        <svg className="w-10 h-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <p className="text-sm">No {mode} episodes available.</p>
      </div>
    );
  }

  // Clamp: `page` is state while `episodes` is a prop — a sub→dub switch can
  // shrink the list so the stored page is out of range (empty grid).
  const clampedPage = Math.min(page, Math.max(0, totalPages - 1));
  const start = clampedPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const currentVisible = currentEp != null && visible.includes(currentEp);
  const currentOnDifferentPage = currentEp != null && !currentVisible && totalPages > 1;
  const hasUnwatched = watchedUpTo != null && episodes.some((ep) => ep > watchedUpTo);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={jumpToEp} className="flex items-center gap-1.5">
          <label htmlFor={`ep-jump-${mode}`} className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
            Jump to ep
          </label>
          <input
            id={`ep-jump-${mode}`}
            type="number"
            min={1}
            inputMode="numeric"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            placeholder={String(episodes[episodes.length - 1])}
            className="w-16 rounded-control border border-border bg-surface px-2 py-1.5 text-xs tabular-nums text-foreground placeholder:text-text-secondary focus:border-accent/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!jump}
            className="rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          >
            Go
          </button>
        </form>
        {hasUnwatched && (
          <button
            type="button"
            aria-pressed={unwatchedOnly}
            onClick={() => setUnwatchedOnly((v) => !v)}
            className={`rounded-chip border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              unwatchedOnly
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-surface text-text-muted hover:text-foreground"
            }`}
          >
            Unwatched only
          </button>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          {Array.from({ length: totalPages }, (_, i) => {
            const lo = i * PAGE_SIZE + 1;
            const hi = Math.min((i + 1) * PAGE_SIZE, episodes.length);
            return (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border ${
                  i === clampedPage
                    ? "bg-accent text-white border-accent shadow-md shadow-accent/20"
                    : "bg-surface text-text-muted border-border hover:border-accent/40 hover:text-foreground"
                }`}
              >
                {lo}–{hi}
              </button>
            );
          })}
          {currentOnDifferentPage && (
            <button
              onClick={() => setPage(Math.floor(episodes.indexOf(currentEp!) / PAGE_SIZE))}
              className="px-3 py-1.5 rounded-full text-xs font-medium bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 transition-colors"
            >
              Jump to Ep {currentEp}
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="rounded-control border border-border bg-surface px-3 py-4 text-center text-xs text-text-secondary">
          You&apos;ve watched every available episode.
        </p>
      )}

      <div className={`grid gap-2.5 ${showInline ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"}`}>
        {visible.map((ep) => {
          const title = titles?.[String(ep)];
          const isActive = currentEp === ep;
          const isWatched = watchedUpTo != null && ep <= watchedUpTo && !isActive;
          return (
            <button
              key={ep}
              onClick={() => onSelect(ep)}
              title={showInline ? undefined : title}
              className={`group relative flex flex-col rounded-xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                isActive
                  ? "bg-accent/15 border-accent shadow-lg shadow-accent/10"
                  : isWatched
                    ? "bg-surface/50 border-border/40 opacity-70 hover:opacity-100"
                    : "bg-surface border-border hover:border-accent/40 hover:bg-surface-hover"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className={`text-base font-bold tabular-nums leading-none ${isActive ? "text-accent" : "text-foreground/90"}`}>
                  {ep}
                </span>
                {isWatched && (
                  <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {isActive && (
                  <span className="text-[9px] font-bold uppercase tracking-wider text-accent">Now</span>
                )}
              </div>
              {showInline && title && (
                <span className={`mt-1.5 text-[11px] leading-snug line-clamp-2 ${isActive ? "text-accent/80" : "text-text-muted"}`}>
                  {title}
                </span>
              )}
              {!showInline && title && (
                <span className="absolute inset-x-0 -bottom-1 translate-y-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 text-[10px] text-foreground bg-surface/95 backdrop-blur border border-border rounded-md px-2 py-1 shadow-lg whitespace-normal max-w-[240px]">
                  {title}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
