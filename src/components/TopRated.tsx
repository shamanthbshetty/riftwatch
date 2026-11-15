"use client";

import { useEffect, useState } from "react";
import { cachedFetch } from "@/lib/cache";
import { addToWatchlist, removeFromWatchlist } from "@/lib/storage";
import { useWatchlistIds } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import AnimeCard from "./AnimeCard";
import Rail from "./Rail";
import RailSkeleton from "./RailSkeleton";
import SectionHeader from "./SectionHeader";
import ToggleButton from "./ToggleButton";

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
      <SectionHeader title="Top Rated" href="/browse/top-rated" />
      <Rail itemCount={items.length}>
        {items.slice(0, 12).map((a) => (
          <AnimeCard
            key={a._id}
            id={a._id || a.malId}
            title={a.title}
            englishName={a.englishName}
            thumbnail={a.thumbnail}
            score={a.score}
            meta={a.genres?.length ? [a.genres.slice(0, 2).join(" · ")] : []}
            className="w-[168px] flex-shrink-0"
            actions={
              <ToggleButton
                active={watchlist.has(a._id)}
                onClick={() => toggleWatchlist(a)}
                label={watchlist.has(a._id) ? "Remove from watchlist" : "Add to watchlist"}
              />
            }
          />
        ))}
      </Rail>
    </section>
  );
}
