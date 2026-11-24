"use client";

import { useEffect, useState } from "react";
import { cachedFetch } from "@/lib/cache";
import { addToWatchlist, removeFromWatchlist } from "@/lib/storage";
import { useWatchlistItems, useAllHistory } from "@/lib/useWatchlists";
import { findWatchlistEntry, isInWatchHistory, type MatchableShow } from "@/lib/show-match";
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
  const watchlist = useWatchlistItems();
  const history = useAllHistory();
  const { toast } = useToast();

  function showRef(a: TopRatedItem): MatchableShow {
    return { id: a._id || a.malId, malId: a.malId, title: a.title, englishName: a.englishName };
  }

  function toggleWatchlist(a: TopRatedItem) {
    const entry = findWatchlistEntry(watchlist, showRef(a));
    if (entry) {
      removeFromWatchlist(entry.id);
      toast("Removed from watchlist");
    } else {
      addToWatchlist({ id: a._id, title: a.title, englishName: a.englishName, thumbnail: a.thumbnail, malId: a.malId, lastEp: 0, mode: "sub" });
      toast("Added to watchlist", "success");
    }
  }

  useEffect(() => {
    cachedFetch<TopRatedItem[]>("/api/top-rated")
      .then((d) => { if (Array.isArray(d)) setItems(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <RailSkeleton />;
  if (items.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Top Rated" href="/browse/top-rated" />
      <Rail itemCount={items.length}>
        {items.slice(0, 12).map((a) => {
          const entry = findWatchlistEntry(watchlist, showRef(a));
          // Already watched? There is nothing to add, so don't offer the "+".
          const watched = isInWatchHistory(history, showRef(a));
          return (
            <AnimeCard
              key={a._id}
              id={a._id || a.malId}
              title={a.title}
              englishName={a.englishName}
              thumbnail={a.thumbnail}
              score={a.score}
              meta={a.genres?.length ? [a.genres.slice(0, 2).join(" · ")] : []}
              className="rail-card"
              actions={
                entry || !watched ? (
                  <ToggleButton
                    active={entry !== null}
                    onClick={() => toggleWatchlist(a)}
                    label={entry ? "Remove from watchlist" : "Add to watchlist"}
                  />
                ) : undefined
              }
            />
          );
        })}
      </Rail>
    </section>
  );
}
