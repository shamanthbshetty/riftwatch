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
  const totalPages = Math.ceil(episodes.length / PAGE_SIZE);

  const initialPage = useMemo(() => {
    if (!currentEp || totalPages <= 1) return 0;
    return Math.floor(episodes.indexOf(currentEp) / PAGE_SIZE);
  }, [currentEp, episodes, totalPages]);

  const [page, setPage] = useState(Math.max(0, initialPage));
  const showInline = episodes.length <= 24;

  if (episodes.length === 0) {
    return <p className="text-text-muted text-sm py-4">No {mode} episodes available.</p>;
  }

  // Clamp: `page` is state while `episodes` is a prop — a sub→dub switch can
  // shrink the list so the stored page is out of range (empty grid).
  const clampedPage = Math.min(page, Math.max(0, totalPages - 1));
  const start = clampedPage * PAGE_SIZE;
  const visible = episodes.slice(start, start + PAGE_SIZE);
  const currentVisible = currentEp != null && visible.includes(currentEp);
  const currentOnDifferentPage = currentEp != null && !currentVisible && totalPages > 1;

  return (
    <div className="space-y-3">
      {totalPages > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          {Array.from({ length: totalPages }, (_, i) => {
            const lo = i * PAGE_SIZE + 1;
            const hi = Math.min((i + 1) * PAGE_SIZE, episodes.length);
            return (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  i === clampedPage ? "bg-accent text-white" : "bg-surface text-text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {lo}–{hi}
              </button>
            );
          })}
          {currentOnDifferentPage && (
            <button
              onClick={() => setPage(Math.floor(episodes.indexOf(currentEp!) / PAGE_SIZE))}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
            >
              Jump to Ep {currentEp}
            </button>
          )}
        </div>
      )}

      <div className={`grid gap-1.5 ${showInline ? "grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10" : "grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12"}`}>
        {visible.map((ep) => {
          const title = titles?.[String(ep)];
          const isActive = currentEp === ep;
          const isWatched = watchedUpTo != null && ep <= watchedUpTo && !isActive;
          return (
            <button
              key={ep}
              onClick={() => onSelect(ep)}
              title={showInline ? undefined : title}
              className={`relative rounded-md text-xs font-medium flex flex-col items-center justify-center transition-colors ${
                showInline ? "py-2.5" : "aspect-square"
              } ${
                isActive
                  ? "bg-accent text-white font-bold shadow-md shadow-accent/20"
                  : isWatched
                    ? "bg-red-600/20 text-red-600 border border-red-600/30"
                    : "bg-surface hover:bg-surface-hover text-text-muted hover:text-foreground"
              }`}
            >
              <span>{ep}</span>
              {showInline && title && (
                <span className="text-[9px] leading-tight opacity-60 line-clamp-2 mt-0.5 px-0.5">{title}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
