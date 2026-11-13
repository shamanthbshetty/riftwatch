"use client";

import { useEffect, useRef, useState } from "react";
import type { WatchStatus } from "@/lib/storage";

export const STATUS_ORDER: WatchStatus[] = ["watching", "completed", "on-hold", "planned"];

export const STATUS_LABELS: Record<WatchStatus, string> = {
  watching: "Watching",
  completed: "Completed",
  "on-hold": "On Hold",
  planned: "Plan to Watch",
};

/** Small solid dot color per status (used inside buttons and menus). */
export const STATUS_DOT: Record<WatchStatus, string> = {
  watching: "bg-sky-500",
  completed: "bg-emerald-500",
  "on-hold": "bg-amber-500",
  planned: "bg-zinc-500",
};

/** Full badge (bg + text) per status, used on watchlist cards. */
export const STATUS_BADGE_TEXT: Record<WatchStatus, string> = {
  watching: "bg-sky-500/90 text-white",
  completed: "bg-emerald-500/90 text-black",
  "on-hold": "bg-amber-500/90 text-black",
  planned: "bg-zinc-500/90 text-white",
};

/** Shared menu panel styling — one look for every status dropdown. */
export const STATUS_MENU_CLASS =
  "rounded-xl bg-surface/95 backdrop-blur-xl border border-border shadow-2xl shadow-black/50 p-1.5 animate-menu-in";

function CheckIcon() {
  return (
    <svg className="w-3.5 h-3.5 ml-auto text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** The status menu body: one pill item per status, current one checked.
    Pass onRemove to append a destructive action under a divider. */
export function StatusMenuList({
  current,
  onPick,
  onRemove,
}: {
  current?: WatchStatus;
  onPick: (s: WatchStatus) => void;
  onRemove?: () => void;
}) {
  return (
    <>
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          className={`flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-colors hover:bg-surface-hover ${
            s === current ? "text-foreground" : "text-text-secondary"
          }`}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[s]}`} />
          {STATUS_LABELS[s]}
          {s === current && <CheckIcon />}
        </button>
      ))}
      {onRemove && (
        <>
          <div className="my-1.5 mx-1 border-t border-border" />
          <button
            onClick={onRemove}
            className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium text-red-400 hover:bg-red-600/10 transition-colors"
          >
            Remove
          </button>
        </>
      )}
    </>
  );
}

interface WatchlistStatusButtonProps {
  inList: boolean;
  status: WatchStatus | null;
  /** Compact sizing for the player controls bar. */
  compact?: boolean;
  onAdd: (status: WatchStatus) => void;
  onChange: (status: WatchStatus) => void;
  onRemove: () => void;
}

/**
 * Watchlist button with a built-in status picker: "+ Watchlist" opens the
 * status menu on add, and once added the button shows the current status and
 * reopens the same menu to change or remove it. Shared by the anime/movie
 * detail pages and the watch pages.
 */
export default function WatchlistStatusButton({ inList, status, compact, onAdd, onChange, onRemove }: WatchlistStatusButtonProps) {
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

  const size = compact
    ? "px-3 py-1.5 rounded-lg text-xs font-medium"
    : "px-4 py-2 rounded-lg text-sm font-medium";
  const current = status ?? "watching";

  function pick(s: WatchStatus) {
    if (inList) onChange(s);
    else onAdd(s);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`${size} btn-tap inline-flex items-center gap-2 border transition-colors ${
          inList
            ? "bg-accent/15 text-accent border-accent/40 hover:bg-accent/25"
            : "bg-surface hover:bg-surface-hover text-text-muted border-border"
        }`}
      >
        {inList ? (
          <>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[current]}`} />
            {STATUS_LABELS[current]}
            <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </>
        ) : (
          "+ Watchlist"
        )}
      </button>
      {open && (
        <div className={`absolute left-0 top-full mt-1.5 w-44 z-40 ${STATUS_MENU_CLASS} origin-top-left`}>
          <StatusMenuList
            current={inList ? current : undefined}
            onPick={pick}
            onRemove={inList ? () => { onRemove(); setOpen(false); } : undefined}
          />
        </div>
      )}
    </div>
  );
}
