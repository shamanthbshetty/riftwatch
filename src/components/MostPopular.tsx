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
      <SectionHeader title="Most Popular" href="/browse/popular" />
      <Rail itemCount={items.length}>
        {items.slice(0, 12).map((s) => (
          <AnimeCard
            key={s._id}
            id={s._id}
            title={s.name}
            englishName={s.englishName}
            thumbnail={s.thumbnail}
            sub={s.availableEpisodes?.sub}
            dub={s.availableEpisodes?.dub}
            className="w-[168px] flex-shrink-0"
            actions={
              <ToggleButton
                active={watchlist.has(s._id)}
                onClick={() => toggleWatchlist(s)}
                label={watchlist.has(s._id) ? "Remove from watchlist" : "Add to watchlist"}
              />
            }
          />
        ))}
      </Rail>
    </section>
  );
}
