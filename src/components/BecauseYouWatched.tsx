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
  genres?: string[];
}

interface RecResponse {
  results?: Rec[];
  seedGenres?: string[];
}

function normalizeTitle(t?: string): string {
  return (t || "").normalize("NFKC").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();
}

export default function BecauseYouWatched() {
  const history = useAllHistory();
  const watchlist = useWatchlistItems();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);

  // Already-watched shows (by AniList id AND title) must never be recommended back.
  const watchedIds = useMemo(
    () =>
      new Set<number>(
        [...history, ...watchlist]
          .map((i) => (typeof i.id === "string" && /^\\d+$/.test(i.id) ? Number(i.id) : NaN))
          .filter((n) => Number.isFinite(n))
      ),
    [history, watchlist]
  );

  const watchedTitles = useMemo(
    () => new Set<string>([...history, ...watchlist].map((i) => normalizeTitle(i.title)).filter(Boolean)),
    [history, watchlist]
  );

  useEffect(() => {
    let cancelled = false;

    // Consider the whole deduped watch history, not just the first few shows.
    const seeds = Array.from(
      new Map(
        history
          .map((h) => {
            const malId = (h.malId || "").trim();
            const id = typeof h.id === "string" && /^\\d+$/.test(h.id) ? h.id : "";
            const key = malId || id;
            return key ? [key, h] : null;
          })
          .filter((x): x is [string, (typeof history)[number]] => x !== null)
      ).values()
    ).slice(0, 10);

    Promise.all(
      seeds.map((s) => {
        const malId = (s.malId || "").trim();
        const id = typeof s.id === "string" && /^\\d+$/.test(s.id) ? s.id : "";
        const qs = malId
          ? `malId=${encodeURIComponent(malId)}`
          : `id=${encodeURIComponent(id)}`;
        return cachedFetch<RecResponse>(`/api/anime/recommendations?${qs}`)
          .then((d) => ({
            results: Array.isArray(d?.results) ? d.results : [],
            seedGenres: Array.isArray(d?.seedGenres) ? d.seedGenres : [],
          }))
          .catch(() => ({ results: [] as Rec[], seedGenres: [] as string[] }));
      })
    ).then((all) => {
      if (cancelled) return;

      // Genre weights: a genre watched more often (across shows) weighs more.
      const genreWeights = new Map<string, number>();
      for (const r of all) {
        for (const g of r.seedGenres) {
          const key = g.toLowerCase().trim();
          if (!key) continue;
          genreWeights.set(key, (genreWeights.get(key) ?? 0) + 1);
        }
      }

      const seen = new Set<number>();
      const merged: Rec[] = [];
      for (const r of all) {
        for (const rec of r.results) {
          if (seen.has(rec.id)) continue;
          if (watchedIds.has(rec.id)) continue;
          if (watchedTitles.has(normalizeTitle(rec.title))) continue;
          seen.add(rec.id);
          merged.push(rec);
        }
      }

      // Sort so shows sharing high-frequency genres surface first.
      merged.sort((a, b) => {
        const score = (rec: Rec) =>
          (rec.genres ?? []).reduce((sum, g) => sum + (genreWeights.get(g.toLowerCase().trim()) ?? 0), 0);
        return score(b) - score(a);
      });

      setRecs(merged.slice(0, 12));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [history, watchedIds, watchedTitles]);

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