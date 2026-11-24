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
  const watchlist = useWatchlistItems();
  const history = useAllHistory();
  const { toast } = useToast();

  function showRef(s: PopularItem): MatchableShow {
    return { id: s._id, malId: s.malId, title: s.name, englishName: s.englishName };
  }

  function toggleWatchlist(s: PopularItem) {
    const entry = findWatchlistEntry(watchlist, showRef(s));
    if (entry) {
      removeFromWatchlist(entry.id);
      toast("Removed from watchlist");
    } else {
      addToWatchlist({ id: s._id, title: s.name, englishName: s.englishName, thumbnail: s.thumbnail, malId: s.malId ?? "", lastEp: 0, mode: "sub" });
      toast("Added to watchlist", "success");
    }
  }

  useEffect(() => {
    cachedFetch<PopularItem[]>("/api/popular")
      .then((d) => { if (Array.isArray(d)) setItems(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <RailSkeleton />;
  if (items.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Most Popular" href="/browse/popular" />
      <Rail itemCount={items.length}>
        {items.slice(0, 12).map((s) => {
          const entry = findWatchlistEntry(watchlist, showRef(s));
          // Already watched? There is nothing to add, so don't offer the "+".
          const watched = isInWatchHistory(history, showRef(s));
          return (
            <AnimeCard
              key={s._id}
              id={s._id}
              title={s.name}
              englishName={s.englishName}
              thumbnail={s.thumbnail}
              sub={s.availableEpisodes?.sub}
              dub={s.availableEpisodes?.dub}
              className="rail-card"
              actions={
                entry || !watched ? (
                  <ToggleButton
                    active={entry !== null}
                    onClick={() => toggleWatchlist(s)}
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
