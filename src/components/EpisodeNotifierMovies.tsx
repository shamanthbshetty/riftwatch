"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { getMovieWatchlist, getTVEpCache, setTVEpCache, addMovieNotification } from "@/lib/storage";

// Watchlist posters are stored as TMDB paths ("/xlaY2….jpg") — <Image> in the
// nav dropdown resolves them against this origin, so a bare path 404s.
const TMDB_W185 = "https://image.tmdb.org/t/p/w185";
function posterForNotif(poster: string): string {
  if (!poster) return "";
  return /^(https?:)?\/\//.test(poster) ? poster : `${TMDB_W185}${poster}`;
}

const POLL_INTERVAL = 5 * 60 * 1000;

// Module-level sweep state: StrictMode/double-mount and rapid pathname flips
// must not launch overlapping sweeps (each sweep is N sequential fetches).
let sweeping = false;
let lastSweepAt = 0;

interface TVDetails {
  seasons?: { season_number: number; episode_count: number }[];
  last_episode_to_air?: {
    season_number?: number;
    episode_number?: number;
    air_date?: string;
  } | null;
}

async function fetchDetails(tmdbId: number): Promise<TVDetails | null> {
  try {
    const res = await fetch(`/api/movies/details?id=${encodeURIComponent(tmdbId)}&type=tv`);
    if (!res.ok) return null;
    return (await res.json()) as TVDetails;
  } catch {
    return null;
  }
}

function mapAbsoluteEpisode(
  seasons: TVDetails["seasons"],
  absoluteEp: number,
): { season: number; episode: number } {
  let ep = absoluteEp;
  for (const s of (seasons ?? []).filter((x) => x.season_number > 0)) {
    if (ep <= s.episode_count) return { season: s.season_number, episode: ep };
    ep -= s.episode_count;
  }
  return { season: 1, episode: absoluteEp };
}

function valid(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1;
}

export default function EpisodeNotifierMovies() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Polling pauses on watch pages so we don't race the page's own fetches.
  // Movie/TV watch pages live at /movies/[id]/watch (the anime ones start
  // with /watch/) — the old startsWith("/watch/") check never matched them,
  // so sweeps kept firing behind an actively playing show.
  const pathname = usePathname();
  const paused =
    pathname.startsWith("/watch/") ||
    (pathname.startsWith("/movies/") && pathname.includes("/watch"));

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    async function checkEpisodes() {
      if (sweeping) return;
      if (Date.now() - lastSweepAt < POLL_INTERVAL) return;
      sweeping = true;
      lastSweepAt = Date.now();
      try {
        const watchlist = getMovieWatchlist().filter((i) => i.type === "tv");
        if (watchlist.length === 0) return;
        const cache = getTVEpCache();

        for (const item of watchlist) {
          if (cancelled) return;
          try {
            const res = await fetch(`/api/movies/tv-episodes?id=${encodeURIComponent(item.id)}`);
            if (cancelled) return;
            if (!res.ok) continue;
            const data = await res.json();
            if (cancelled) return;
            const total = data.total ?? 0;
            const prev = cache[item.id] ?? 0;

            if (prev > 0 && total > prev) {
              const newEps = total - prev;
              const details = await fetchDetails(Number(item.id));
              if (cancelled) return;

              // Newest aired episode: TMDB's `last_episode_to_air` carries the
              // exact season/episode and the date it aired, so the notice opens
              // (and dates) the episode it is about instead of the first one the
              // counter gained.
              const last = details?.last_episode_to_air ?? null;
              const mapped = mapAbsoluteEpisode(details?.seasons, prev + 1);
              const season = valid(last?.season_number) ? Number(last!.season_number) : mapped.season;
              const episode = valid(last?.episode_number) ? Number(last!.episode_number) : mapped.episode;
              const airDate = typeof last?.air_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(last!.air_date as string)
                ? (last!.air_date as string)
                : undefined;

              addMovieNotification({
                id: `tv-${item.id}-${total}`,
                title: item.title,
                body: `${newEps} new ${newEps === 1 ? "episode" : "episodes"} available`,
                thumbnail: posterForNotif(item.poster || ""),
                href: `/movies/${item.id}/watch?type=tv&season=${season}&episode=${episode}`,
                releasedAt: airDate,
                episodeLabel: `S${season}E${episode}`,
              });
            }
            setTVEpCache(item.id, total);
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