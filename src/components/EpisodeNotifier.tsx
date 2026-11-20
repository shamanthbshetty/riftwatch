"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { getWatchlist, getEpCache, setEpCache, setFullEpCache, addNotification } from "@/lib/storage";

const POLL_INTERVAL = 5 * 60 * 1000;

// Module-level sweep state: StrictMode/double-mount and rapid pathname flips
// must not launch overlapping sweeps (each sweep is N sequential fetches).
let sweeping = false;
let lastSweepAt = 0;

/** Highest episode number in an AllAnime id list ("1".."12"); falls back to
 *  the count when a provider returns opaque ids instead of numbers. */
function latestEpisode(list: string[]): number {
  let max = 0;
  for (const v of list) {
    if (/^\d+$/.test(v)) max = Math.max(max, Number(v));
  }
  return max || list.length;
}

export default function EpisodeNotifier() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Polling pauses on watch pages so we don't race the page's own episode
  // fetches / burn quota while the user is actively watching.
  const pathname = usePathname();
  const paused = pathname.startsWith("/watch/");

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    async function checkEpisodes() {
      if (sweeping) return;
      if (Date.now() - lastSweepAt < POLL_INTERVAL) return;
      sweeping = true;
      lastSweepAt = Date.now();
      try {
        const watchlist = getWatchlist();
        if (watchlist.length === 0) return;
        const cache = getEpCache();
        const watchIds = new Set(watchlist.map((w) => w.id));

        let pruned = false;
        for (const id of Object.keys(cache)) {
          if (!watchIds.has(id)) { delete cache[id]; pruned = true; }
        }
        if (pruned) {
          try { setFullEpCache(cache); } catch {}
        }

        for (const item of watchlist) {
          if (cancelled) return;
          try {
            const res = await fetch(`/api/episodes?id=${encodeURIComponent(item.id)}`);
            if (cancelled) return;
            if (!res.ok) continue;
            const data = await res.json();
            if (cancelled) return;
            const subEps: string[] = data.availableEpisodesDetail?.sub ?? [];
            const dubEps: string[] = data.availableEpisodesDetail?.dub ?? [];
            const subCount = subEps.length;
            const dubCount = dubEps.length;
            const title = data.englishName || data.name || item.englishName || item.title;

            const prev = cache[item.id];
            let prevSub = 0;
            let prevDub = 0;
            if (typeof prev === "object" && prev !== null) {
              prevSub = prev.sub;
              prevDub = prev.dub;
            } else if (typeof prev === "number") {
              prevSub = prev;
              prevDub = 0;
            }

            const newSub = subCount > prevSub ? subCount - prevSub : 0;
            const newDub = dubCount > prevDub ? dubCount - prevDub : 0;

            // Link to the latest available episode, not the first "new" one —
            // otherwise a show that went from 0 → N available reads as ep 1.
            const latestSub = latestEpisode(subEps);
            const latestDub = latestEpisode(dubEps);

            if (prev !== undefined && (newSub > 0 || newDub > 0)) {
              const subEp = newSub > 0 ? latestSub : 0;
              const dubEp = newDub > 0 ? latestDub : 0;
              const notifyEp = subEp || dubEp;
              const parts: string[] = [];
              if (newSub > 0) parts.push(`${newSub} sub`);
              if (newDub > 0) parts.push(`${newDub} dub`);

              // Release date: only fetch when a notification is actually created,
              // so the per-poll path never spends AniList calls.
              let releasedAt: string | undefined;
              if (data.malId && notifyEp > 0) {
                try {
                  const r = await fetch(`/api/anime/ep-date?malId=${encodeURIComponent(data.malId)}&ep=${notifyEp}`);
                  if (r.ok) {
                    const d = await r.json();
                    if (typeof d?.airDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.airDate)) releasedAt = d.airDate;
                  }
                } catch { /* skip */ }
              }

              addNotification({
                id: `${item.id}-${subCount + dubCount}`,
                title,
                body: `New: ${parts.join(", ")}`,
                thumbnail: item.thumbnail,
                href: `/watch/${item.id}?ep=${notifyEp}&mode=${newSub > 0 ? "sub" : "dub"}`,
                hrefSub: newSub > 0 ? `/watch/${item.id}?ep=${latestSub}&mode=sub` : undefined,
                hrefDub: newDub > 0 ? `/watch/${item.id}?ep=${latestDub}&mode=dub` : undefined,
                subCount: newSub,
                dubCount: newDub,
                releasedAt,
                episodeLabel: notifyEp > 0 ? `Ep ${notifyEp}` : undefined,
              });
            }
            setEpCache(item.id, { sub: subCount, dub: dubCount });
          } catch { /* skip */ }
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        sweeping = false;
      }
    }

    checkEpisodes();
    timerRef.current = setInterval(checkEpisodes, POLL_INTERVAL);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [paused]);

  return null;
}