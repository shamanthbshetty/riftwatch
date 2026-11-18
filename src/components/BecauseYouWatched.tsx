"use client";

import { useEffect, useMemo, useState } from "react";
import MediaCard from "./MediaCard";
import Rail from "./Rail";
import SectionHeader from "./SectionHeader";
import { useAllHistory, useWatchlistItems } from "@/lib/useWatchlists";
import { cachedFetch } from "@/lib/cache";

interface Rec {
  id: number;
  title: string;
  thumbnail: string;
}

export default function BecauseYouWatched() {
  const history = useAllHistory();
  const watchlist = useWatchlistItems();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);

  // Already-watched shows (by AniList id) must never be recommended back.
  const watchedIds = useMemo(
    () =>
      new Set<number>(
        [...history, ...watchlist]
          .map((i) => (typeof i.id === "string" && /^\d+$/.test(i.id) ? Number(i.id) : NaN))
          .filter((n) => Number.isFinite(n))
      ),
    [history, watchlist]
  );

  useEffect(() => {
    let cancelled = false;
    const seeds = Array.from(
      new Map(history.map((h) => [h.malId, h])).values()
    ).slice(0, 3);

    Promise.all(
      seeds.map((s) =>
        cachedFetch<{ results: Rec[] }>(
          `/api/anime/recommendations?malId=${encodeURIComponent(s.malId)}`
        )
          .then((d) => (Array.isArray(d?.results) ? d.results : []))
          .catch(() => [] as Rec[])
      )
    ).then((all) => {
      if (cancelled) return;
      const seen = new Set<number>();
      const merged: Rec[] = [];
      for (const list of all) {
        for (const r of list) {
          if (seen.has(r.id) || watchedIds.has(r.id)) continue;
          seen.add(r.id);
          merged.push(r);
          if (merged.length >= 12) break;
        }
        if (merged.length >= 12) break;
      }
      setRecs(merged);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [history, watchedIds]);

  if (loading) return null;
  if (recs.length === 0) return null;

  return (
    <section aria-label="You might like">
      <SectionHeader title="You might like" />
      <Rail itemCount={recs.length}>
        {recs.map((r) => (
          <MediaCard
            key={r.id}
            href={`/anime/${r.id}`}
            title={r.title}
            image={r.thumbnail}
            className="w-[168px] flex-shrink-0"
          />
        ))}
      </Rail>
    </section>
  );
}
