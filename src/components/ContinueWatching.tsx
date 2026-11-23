"use client";

import { useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { Play, X } from "lucide-react";
import { formatMediaTime, removeShowFromHistory, type HistoryItem } from "@/lib/storage";
import { useContinueWatching, useShowResume } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import Rail from "./Rail";
import SectionHeader from "./SectionHeader";

function ContinueCard({ item, onRemove }: { item: HistoryItem; onRemove: (id: string) => void }) {
  const resume = useShowResume(item.id);
  const targetEp = resume && resume.ep >= 1 ? resume.ep : item.ep;
  const targetMode = resume && (resume.mode === "sub" || resume.mode === "dub") ? resume.mode : item.mode;
  const t = resume && resume.t > 10 ? resume.t : 0;
  const duration = resume?.d && resume.d > 0 ? resume.d : 0;
  const frac = duration > 0 && t > 0 ? Math.min(0.98, t / duration) : 0;

  return (
    <div className="group relative w-[168px] flex-shrink-0">
      <Link
        href={`/watch/${item.id}?ep=${targetEp}&mode=${targetMode}${item.title ? `&title=${encodeURIComponent(item.title)}` : ""}`}
        className="block"
        title={item.englishName || item.title}
      >
        <div className="card-hover relative aspect-[3/4] overflow-hidden rounded-surface bg-surface">
          {item.thumbnail ? (
            <Image src={item.thumbnail} alt="" fill sizes="168px" className="object-cover" unoptimized />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xs text-text-secondary">N/A</div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />

          {frac > 0 && (
            <div className="absolute inset-x-0 bottom-[34px] h-[3px] bg-white/15">
              <div className="h-full bg-accent" style={{ width: `${frac * 100}%` }} />
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/75 px-2 py-1.5 backdrop-blur-sm">
            <span className="text-2xs font-semibold text-white">EP {targetEp}</span>
            {duration > 0 && t > 0 && (
              <span className="text-2xs tabular-nums text-white/70">
                {formatMediaTime(t)} / {formatMediaTime(duration)}
              </span>
            )}
          </div>

          <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/40 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-white text-white" aria-hidden />
            </span>
          </span>
        </div>
      </Link>
      <p className="mt-2 line-clamp-2 text-xs font-medium leading-snug text-foreground/90">
        {item.englishName || item.title}
      </p>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(item.id); }}
        aria-label="Remove from continue watching"
        className="absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white/80 opacity-0 transition-[opacity,color,border-color] hover:border-red-400/60 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

export default function ContinueWatching() {
  const items = useContinueWatching();
  const { toast } = useToast();

  const remove = useCallback((id: string) => {
    removeShowFromHistory(id);
    toast("Removed from history");
  }, [toast]);

  if (items.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Continue Watching" href="/history" emphasis />
      <Rail itemCount={items.length}>
        {items.map((item) => (
          <ContinueCard key={`${item.id}-${item.ep}`} item={item} onRemove={remove} />
        ))}
      </Rail>
    </section>
  );
}
