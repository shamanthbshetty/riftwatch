"use client";

import { useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { formatMediaTime, removeFromHistory, type HistoryItem } from "@/lib/storage";
import { useContinueWatching, useShowResume } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import Rail from "./Rail";

function ContinueCard({ item, onRemove }: { item: HistoryItem; onRemove: (id: string, ep: number) => void }) {
  const resume = useShowResume(item.id);
  // Only show the timestamp when it belongs to this exact episode+mode —
  // the newest resume entry can be from an earlier episode.
  const t = resume && resume.ep === item.ep && resume.mode === item.mode && resume.t > 10
    ? formatMediaTime(resume.t)
    : null;
  return (
    <div className="relative group flex-shrink-0 w-[180px]">
      <Link href={`/watch/${item.id}?ep=${item.ep}&mode=${item.mode}${item.title ? `&title=${encodeURIComponent(item.title)}` : ""}`} className="block">
        <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface card-hover">
          {item.thumbnail ? (
            <Image
              src={item.thumbnail}
              alt={item.title}
              fill
              sizes="180px"
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              unoptimized
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-0 left-0 right-0 p-2.5 space-y-1">
            <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{item.englishName || item.title}</p>
            <span className="text-[10px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full inline-block">
              EP {item.ep} &middot; {item.mode.toUpperCase()}{t ? ` · ${t}` : ""}
            </span>
          </div>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(item.id, item.ep); }}
            className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/70 border border-white/30 flex items-center justify-center text-white hover:text-red-400 hover:border-red-400/60 hover:bg-black/90 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 transition-[opacity,transform,color,border-color,background-color] z-30"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </Link>
    </div>
  );
}

export default function ContinueWatching() {
  const items = useContinueWatching();
  const { toast } = useToast();

  const remove = useCallback((id: string, ep: number) => {
    removeFromHistory(id, ep);
    toast("Removed from history");
  }, [toast]);

  if (items.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <Link href="/history" className="text-lg font-semibold section-title hover:text-accent transition-colors">Continue Watching</Link>
      </div>
      <Rail itemCount={items.length}>
        {items.slice(0, 7).map((item) => (
          <ContinueCard key={`${item.id}-${item.ep}`} item={item} onRemove={remove} />
        ))}
      </Rail>
    </section>
  );
}
