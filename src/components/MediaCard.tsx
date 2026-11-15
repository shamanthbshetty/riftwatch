"use client";

import Image from "next/image";
import Link from "next/link";
import { Play, Star } from "lucide-react";

export interface MediaCardProps {
  href: string;
  title: string;
  image?: string | null;
  /** Numeric score; shown as a small chip when set. */
  score?: number | null;
  /** Rail position — renders as a large editorial numeral instead of a pill. */
  rank?: number;
  sub?: number;
  dub?: number;
  /** Quiet metadata appended to the caption row, e.g. ["24 EP", "2024"]. */
  meta?: string[];
  /** Amber note (replaces rank), e.g. "Upcoming". */
  note?: string | null;
  /** Overlay controls (watchlist toggle, status menu, …). */
  actions?: React.ReactNode;
  className?: string;
  sizes?: string;
}

/**
 * The one poster card used by every surface (home rails, search, browse,
 * watchlist). Metadata is one caption row, not a row of pills: availability
 * reads as coloured SUB/DUB words, score as a single corner chip.
 */
export default function MediaCard({
  href,
  title,
  image,
  score,
  rank,
  sub,
  dub,
  meta,
  note,
  actions,
  className,
  sizes = "(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 190px",
}: MediaCardProps) {
  const hasCaption = (sub ?? 0) > 0 || (dub ?? 0) > 0 || (meta?.length ?? 0) > 0;
  const showRank = rank != null && !note;
  const showScore = score != null && score > 0;

  return (
    <div className={`group relative ${className ?? ""}`}>
      <Link href={href} className="block rounded-surface">
        <div className="card-hover relative aspect-[3/4] overflow-hidden rounded-surface bg-surface">
          {image ? (
            <Image
              src={image}
              alt={title}
              fill
              sizes={sizes}
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-4 text-center text-2xs text-text-secondary">
              {title}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] bg-gradient-to-t from-black/95 via-black/50 to-transparent" />

          {showRank && (
            <span className="absolute left-2.5 top-1.5 text-2xl font-semibold leading-none tabular-nums text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.85)]">
              {String(rank).padStart(2, "0")}
            </span>
          )}

          {note && (
            <span className="absolute left-2 top-2 rounded-control bg-amber-400/90 px-1.5 py-0.5 text-2xs font-semibold text-black">
              {note}
            </span>
          )}

          {showScore && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-control bg-black/55 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white ring-1 ring-white/15 backdrop-blur-sm">
              <Star className="h-3 w-3 fill-amber-300 text-amber-300" aria-hidden />
              {score.toFixed(1)}
            </span>
          )}

          <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/40 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-white text-white" aria-hidden />
            </span>
          </span>

          <div className="absolute inset-x-0 bottom-0 p-2.5">
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-white">{title}</p>
            {hasCaption && (
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs font-medium text-white/65">
                {(sub ?? 0) > 0 && <span className="font-semibold text-rose-300">SUB</span>}
                {(dub ?? 0) > 0 && <span className="font-semibold text-amber-300">DUB</span>}
                {meta && meta.length > 0 && <span className="truncate">{meta.join(" · ")}</span>}
              </div>
            )}
          </div>
        </div>
      </Link>
      {actions}
    </div>
  );
}
