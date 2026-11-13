"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { cachedFetch } from "@/lib/cache";
import { addToWatchlist, removeFromWatchlist } from "@/lib/storage";
import { useWatchlistIds } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import Rail from "./Rail";
import RailSkeleton from "./RailSkeleton";

interface PopularItem {
  _id: string;
  name: string;
  englishName?: string;
  thumbnail: string;
  malId?: string;
  availableEpisodes: { sub: number; dub: number };
}

export default function MostPopular() {
  const [items, setItems] = useState<PopularItem[]>([]);
  const [loading, setLoading] = useState(true);
  const watchlist = useWatchlistIds();
  const { toast } = useToast();

  useEffect(() => {
    cachedFetch<PopularItem[]>("/api/popular")
      .then((d) => { if (Array.isArray(d)) setItems(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleWatchlist(s: PopularItem) {
    if (watchlist.has(s._id)) {
      removeFromWatchlist(s._id);
      toast("Removed from watchlist");
    } else {
      addToWatchlist({ id: s._id, title: s.name, englishName: s.englishName, thumbnail: s.thumbnail, malId: s.malId ?? "", lastEp: 0, mode: "sub" });
      toast("Added to watchlist", "success");
    }
  }

  if (loading) return <RailSkeleton />;
  if (items.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <Link href="/browse/popular">
          <h2 className="text-lg font-semibold section-title hover:text-accent transition-colors">Most Popular</h2>
        </Link>
        <span className="text-xs text-text-secondary">Last 30 days</span>
      </div>
      <Rail itemCount={items.length}>
        {items.slice(0, 7).map((s) => (
          <div key={s._id} className="relative flex-shrink-0 w-[180px] group">
            <Link href={`/anime/${s._id}`} className="block">
              <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface card-hover">
                {s.thumbnail ? <Image src={s.thumbnail} alt={s.name} fill sizes="180px" className="object-cover transition-transform duration-300 group-hover:scale-105" unoptimized onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /> : <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80" />
                <div className="absolute bottom-0 left-0 right-0 p-2.5">
                  <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{s.englishName || s.name}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    {s.availableEpisodes?.sub > 0 && <span className="text-[9px] font-bold bg-badge-sub/80 text-white px-1 py-0.5 rounded-full">SUB</span>}
                    {s.availableEpisodes?.dub > 0 && <span className="text-[9px] font-bold bg-badge-dub/80 text-black px-1 py-0.5 rounded-full">DUB</span>}
                  </div>
                </div>
              </div>
            </Link>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleWatchlist(s); }}
              className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-[opacity,background-color,border-color,color] z-30 ${
                watchlist.has(s._id) ? "bg-accent text-white" : "bg-surface/90 border border-border text-text-muted hover:text-foreground"
              }`}
            >
              {watchlist.has(s._id) ? (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
              )}
            </button>
          </div>
        ))}
      </Rail>
    </section>
  );
}
