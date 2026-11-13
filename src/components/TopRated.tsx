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

interface TopRatedItem {
  _id: string;
  malId: string;
  title: string;
  englishName?: string;
  thumbnail: string;
  score: number | null;
  genres: string[];
}

export default function TopRated() {
  const [items, setItems] = useState<TopRatedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const watchlist = useWatchlistIds();
  const { toast } = useToast();

  useEffect(() => {
    cachedFetch<TopRatedItem[]>("/api/top-rated")
      .then((d) => { if (Array.isArray(d)) setItems(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleWatchlist(a: TopRatedItem) {
    if (watchlist.has(a._id)) {
      removeFromWatchlist(a._id);
      toast("Removed from watchlist");
    } else {
      addToWatchlist({ id: a._id, title: a.title, englishName: a.englishName, thumbnail: a.thumbnail, malId: a.malId, lastEp: 0, mode: "sub" });
      toast("Added to watchlist", "success");
    }
  }

  if (loading) return <RailSkeleton />;
  if (items.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <Link href="/browse/top-rated">
          <h2 className="text-lg font-semibold section-title hover:text-accent transition-colors">Top Rated</h2>
        </Link>
      </div>
      <Rail itemCount={items.length}>
        {items.slice(0, 7).map((a) => (
          <div key={a._id} className="relative flex-shrink-0 w-[180px] group">
            <Link href={`/anime/${a._id || a.malId}`} className="block">
              <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface card-hover">
                {a.thumbnail ? <Image src={a.thumbnail} alt={a.title} fill sizes="180px" className="object-cover transition-transform duration-300 group-hover:scale-105" unoptimized /> : <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80" />
                <div className="absolute top-1.5 left-1.5">
                  <span className="text-[10px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full">
                    ★ {a.score ?? "N/A"}
                  </span>
                </div>
                <div className="absolute bottom-0 left-0 right-0 p-2.5">
                  <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{a.englishName || a.title}</p>
                  {a.genres && a.genres.length > 0 && (
                    <p className="text-[9px] text-white/70 truncate mt-1">{a.genres.slice(0, 2).join(" · ")}</p>
                  )}
                </div>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleWatchlist(a); }}
                  className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-[opacity,background-color,border-color,color] z-30 ${
                    watchlist.has(a._id) ? "bg-accent text-white" : "bg-surface/90 border border-border text-text-muted hover:text-foreground"
                  }`}
                >
                  {watchlist.has(a._id) ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                  )}
                </button>
              </div>
            </Link>
          </div>
        ))}
      </Rail>
    </section>
  );
}
