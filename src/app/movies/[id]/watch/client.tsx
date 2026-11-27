"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/lib/tauri-router";
import { useRouteParam } from "@/lib/use-route-param";
import VideoPlayer from "@/components/VideoPlayer";
import IframePlayer from "@/components/IframePlayer";
import { addToMovieHistory, addToMovieWatchlist, removeFromMovieWatchlist, setMovieWatchlistStatus, setAutoplayPref, type WatchStatus } from "@/lib/storage";
import { useMovieWatchlistItems, useAutoplayPref, useMovieWatchedUpTo } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import WatchlistStatusButton, { STATUS_LABELS } from "@/components/WatchlistStatusButton";
import { posterUrl } from "@/lib/movies";
import { backendMediaUrl } from "@/lib/api-base";

interface TVEpisode {
  episode_number: number;
  name: string;
}

interface Season {
  season_number: number;
  episode_count: number;
  name: string;
}

interface StreamSource {
  name: string;
  streamUrl?: string;
  embedUrl?: string;
  source: string;
  isEmbed?: boolean;
}

interface Subtitle {
  label: string;
  url: string;
}

const EMPTY_SOURCES: StreamSource[] = [];
const EMPTY_SUBS: Subtitle[] = [];
const EMPTY_EPISODES: TVEpisode[] = [];
const EMPTY_SEASONS: Season[] = [];

export default function MovieWatchPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = useRouteParam("id");
  // Anything other than an explicit ?type=tv is a movie — the old cast accepted
  // any garbage (type=banana → "banana") and only failed deep in the fetches.
  const type = searchParams.get("type") === "tv" ? "tv" : "movie";
  // NaN/garbage/0 from the URL collapses to 1 instead of propagating as
  // `season=NaN` into the fetch and a 400 from the API.
  const season = Math.max(1, Math.floor(Number(searchParams.get("season") ?? "1")) || 1);
  const episode = Math.max(1, Math.floor(Number(searchParams.get("episode") ?? "1")) || 1);
  const [retryKey, setRetryKey] = useState(0);
  // Hide-watched: persisted opt-in filter for the TV episode list.
  const [hideWatched, setHideWatched] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("hide-watched") === "1"; } catch { return false; }
  });
  const toggleHideWatched = () => {
    setHideWatched((v) => {
      const next = !v;
      try { localStorage.setItem("hide-watched", next ? "1" : "0"); } catch { /* quota exceeded */ }
      return next;
    });
  };
  const autoPlay = useAutoplayPref();
  const movieWatchlist = useMovieWatchlistItems();
  const inWatchlist = movieWatchlist.some((i) => i.id === id);
  const wlStatus = movieWatchlist.find((i) => i.id === id)?.status ?? null;
  const { toast } = useToast();

  // Every piece of request-scoped state is tagged with the request that produced
  // it and derived back out, so changing episode/season can't leave stale data on
  // screen and no effect has to synchronously reset state.
  const streamKey = `${id}|${type}|${season}|${episode}|${retryKey}`;
  const [stream, setStream] = useState<{
    key: string;
    sources: StreamSource[];
    subtitles: Subtitle[];
    title: string;
    poster: string;
    error: string;
  } | null>(null);
  const [selection, setSelection] = useState({ key: "", index: 0 });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [episodesState, setEpisodesState] = useState<{ key: string; list: TVEpisode[] } | null>(null);
  const [seasonsState, setSeasonsState] = useState<{ key: string; list: Season[] } | null>(null);

  const current = stream?.key === streamKey ? stream : null;
  const sources = current?.sources ?? EMPTY_SOURCES;
  const subtitles = current?.subtitles ?? EMPTY_SUBS;
  // Subtitle URLs from the backend are relative proxy paths; in Tauri they must
  // point at the sidecar instead of the custom protocol origin.
  const playerSubtitles = useMemo(
    () => subtitles.map((s) => ({ ...s, url: backendMediaUrl(s.url) })),
    [subtitles],
  );
  const title = current?.title ?? "";
  const poster = current?.poster ?? "";
  const error = current?.error ?? "";
  const loading = current === null;

  const selectedSource = selection.key === streamKey ? selection.index : 0;
  const playerError = failedKey === streamKey;

  const tvKey = `${id}|${season}`;
  const episodes = type === "tv" && episodesState?.key === tvKey ? episodesState.list : EMPTY_EPISODES;
  const seasons = type === "tv" && seasonsState?.key === `${id}|${type}` ? seasonsState.list : EMPTY_SEASONS;

  function selectSource(index: number) {
    const name = sources[index]?.name;
    setSelection({ key: streamKey, index });
    setFailedKey(null);
    if (index !== selectedSource && name) toast(`Playing from ${name}`);
  }

  function addWithStatus(status: WatchStatus) {
    addToMovieWatchlist({ id, title: title || "Untitled", poster, type, status });
    toast(`Added as ${STATUS_LABELS[status]}`, "success");
  }

  function changeStatus(status: WatchStatus) {
    setMovieWatchlistStatus(id, status);
    toast(`Marked as ${STATUS_LABELS[status]}`);
  }

  function removeFromList() {
    removeFromMovieWatchlist(id);
    toast("Removed from watchlist");
  }

  useEffect(() => {
    let cancelled = false;
    const qs = `id=${encodeURIComponent(id)}&type=${type}${type === "tv" ? `&season=${season}&episode=${episode}` : ""}`;
    fetch(`/api/movies/stream?${qs}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setStream({
          key: streamKey,
          sources: Array.isArray(data.sources) ? data.sources : EMPTY_SOURCES,
          subtitles: Array.isArray(data.subtitles) ? data.subtitles : EMPTY_SUBS,
          title: data.title ?? "",
          poster: data.poster ?? "",
          error: data.error ?? "",
        });
      })
      .catch(() => {
        if (!cancelled) {
          setStream({ key: streamKey, sources: EMPTY_SOURCES, subtitles: EMPTY_SUBS, title: "", poster: "", error: "Failed to load stream" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, type, season, episode, retryKey, streamKey]);

  // Episode list for TV shows
  useEffect(() => {
    if (type !== "tv") return;
    let cancelled = false;
    fetch(`/api/movies/episodes?id=${encodeURIComponent(id)}&season=${season}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setEpisodesState({ key: `${id}|${season}`, list: Array.isArray(data) ? data : [] });
      })
      .catch(() => {
        if (!cancelled) setEpisodesState({ key: `${id}|${season}`, list: [] });
      });
    return () => {
      cancelled = true;
    };
    // retryKey: a transient episodes failure should recover on "Try Again",
    // not require a full navigation.
  }, [id, type, season, retryKey]);

  // Seasons list for TV shows
  useEffect(() => {
    if (type !== "tv") return;
    let cancelled = false;
    fetch(`/api/movies/details?id=${encodeURIComponent(id)}&type=tv`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSeasonsState({ key: `${id}|${type}`, list: data.seasons ?? [] });
      })
      .catch(() => {
        if (!cancelled) setSeasonsState({ key: `${id}|${type}`, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [id, type]);

  // History is written when playback ACTUALLY starts (parity with the anime
  // watch page): opening a broken episode must not mark it watched. The write
  // retries when title/poster land after the player already reported playing.
  const playedKeyRef = useRef<string | null>(null);
  const historyWrittenKeyRef = useRef<string | null>(null);
  const writeMovieHistory = useCallback(() => {
    if (!title || playedKeyRef.current !== streamKey) return;
    if (historyWrittenKeyRef.current === streamKey) return;
    historyWrittenKeyRef.current = streamKey;
    const posterFull = poster ? (posterUrl(poster) ?? "") : "";
    addToMovieHistory({ id, title, poster: posterFull, type, season: type === "tv" ? season : undefined, episode: type === "tv" ? episode : 1 });
  }, [title, poster, streamKey, id, type, season, episode]);
  const markPlayed = useCallback(() => {
    playedKeyRef.current = streamKey;
    writeMovieHistory();
  }, [streamKey, writeMovieHistory]);
  useEffect(() => {
    writeMovieHistory();
  }, [writeMovieHistory]);

  const goEp = useCallback((s: number, e: number) => {
    router.push(`/movies/${id}/watch?type=tv&season=${s}&episode=${e}`);
  }, [id, router]);

  // Season bounds shared by the nav buttons and the auto-next countdown.
  const lastEpThisSeason = episodes.length > 0 ? Math.max(...episodes.map((e) => e.episode_number)) : null;
  const hasNextSeason = seasons.some((s) => s.season_number > season && s.episode_count > 0);
  // Unknown episode list → leave enabled (old behavior); otherwise stop at
  // the end of the season unless another season follows.
  const hasNext = lastEpThisSeason === null
    ? true
    : episode < lastEpThisSeason || hasNextSeason;
  const atSeasonEnd = lastEpThisSeason !== null && episode >= lastEpThisSeason;

  // View-based high-water mark for the red watched tiles (anime parity).
  const watchedUpTo = useMovieWatchedUpTo(id);
  const isEpisodeWatched = (epNum: number) =>
    watchedUpTo?.season != null &&
    (season < watchedUpTo.season ||
      (season === watchedUpTo.season && epNum <= (watchedUpTo.episode ?? 0)));
  // The current episode always stays visible even when hide-watched is on.
  const visibleEpisodes = hideWatched
    ? episodes.filter((ep) => ep.episode_number === episode || !isEpisodeWatched(ep.episode_number))
    : episodes;

  const handleNextEpisode = useCallback(() => {
    if (atSeasonEnd && hasNextSeason) goEp(season + 1, 1);
    else goEp(season, episode + 1);
  }, [atSeasonEnd, hasNextSeason, season, episode, goEp]);

  const currentSource = sources[selectedSource];
  // Key on the actual media URL: keying on the provider name kept the player
  // mounted across episode switches, so subtitle selection from the previous
  // episode survived into the next one un-applied.
  const playerKey = `${currentSource?.source}-${currentSource?.streamUrl ?? currentSource?.embedUrl ?? ""}-${retryKey}`;

  // Two fatal errors can land in the same tick (video onError + hls fatal) —
  // without the 300ms dedupe the failover would skip a source, same as the
  // anime watch page.
  const lastFailRef = useRef<{ key: string; ts: number } | null>(null);
  const autoRetryRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  const handlePlayerError = useCallback(() => {
    const now = Date.now();
    if (lastFailRef.current && lastFailRef.current.key === streamKey && now - lastFailRef.current.ts < 300) {
      return;
    }
    lastFailRef.current = { key: streamKey, ts: now };
    const nextIdx = sources.findIndex((s, i) => i > selectedSource && (s.streamUrl || s.embedUrl));
    if (nextIdx !== -1) {
      setSelection({ key: streamKey, index: nextIdx });
      setFailedKey(null);
    } else {
      // Sources exhausted: one silent re-resolution before the dead-end panel
      // (capped) so a transient upstream reset recovers without a manual Retry.
      const base = streamKey.split("|").slice(0, 4).join("|");
      const count = autoRetryRef.current.key === base ? autoRetryRef.current.count : 0;
      if (count < 2) {
        autoRetryRef.current = { key: base, count: count + 1 };
        setSelection({ key: streamKey, index: 0 });
        setFailedKey(null);
        setRetryKey((k) => k + 1);
      } else {
        setFailedKey(streamKey);
      }
    }
  }, [sources, selectedSource, streamKey]);

  return (
    <div className="max-w-7xl mx-auto page-top pb-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.push(`/movies/${id}`)} className="text-text-muted hover:text-foreground transition-colors" title="Back to details">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div>
          <h1 className="text-sm font-semibold">{title || "Loading..."}</h1>
          {type === "tv" && (
            <p className="text-xs text-text-muted">Season {season} &middot; Episode {episode}</p>
          )}
        </div>
      </div>

      {/* Player */}
      {loading && (
        <div className="aspect-video rounded-lg bg-surface animate-pulse flex items-center justify-center text-text-muted text-sm">
          Loading player...
        </div>
      )}
      {error && (
        <div className="aspect-video rounded-lg bg-surface flex items-center justify-center text-red-500 text-sm">
          {error}
        </div>
      )}
      {!loading && !error && currentSource?.streamUrl && !playerError && (
        <VideoPlayer
          key={playerKey}
          src={backendMediaUrl(currentSource.streamUrl)}
          subtitles={playerSubtitles}
          onError={handlePlayerError}
          onEnded={type === "tv" && hasNext && autoPlay ? handleNextEpisode : undefined}
          onFirstPlay={markPlayed}
          storageKey={`movie|${id}|${type}|${type === "tv" ? `${season}|${episode}` : "1"}`}
          nextLabel={type === "tv" ? (atSeasonEnd ? `S${season + 1}E1` : `S${season}E${episode + 1}`) : undefined}
        />
      )}
      {!loading && !error && currentSource?.embedUrl && !playerError && (
        <IframePlayer
          key={playerKey}
          src={currentSource.embedUrl}
          onError={handlePlayerError}
          onLoad={markPlayed}
        />
      )}
      {playerError && (
        <div className="aspect-video rounded-lg bg-surface flex flex-col items-center justify-center text-text-muted text-sm gap-3">
          <p>All sources failed</p>
          <button
            onClick={() => { setFailedKey(null); setRetryKey((k) => k + 1); }}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-surface-hover hover:bg-border transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Provider selector */}
      {!loading && sources.length >= 1 && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary font-medium uppercase tracking-wide">Servers</p>
          <div className="flex gap-1.5 flex-wrap">
            {sources.map((s, i) => (
              <button
                key={i}
                onClick={() => selectSource(i)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  i === selectedSource
                    ? "bg-accent text-white shadow-sm"
                    : "bg-surface text-text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2">
          <WatchlistStatusButton
            compact
            inList={inWatchlist}
            status={wlStatus}
            onAdd={addWithStatus}
            onChange={changeStatus}
            onRemove={removeFromList}
          />
          <button
            onClick={() => setAutoplayPref(!autoPlay)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              autoPlay ? "bg-accent/20 text-accent" : "bg-surface text-text-muted"
            }`}
          >
            Auto {autoPlay ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      {/* Episode list skeleton while a season's episodes load */}
      {type === "tv" && episodesState?.key !== tvKey && (
        <section>
          <div className="skeleton h-4 w-40 rounded mb-3" />
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-10 rounded-md" />
            ))}
          </div>
        </section>
      )}

      {/* Episode list for TV shows */}
      {type === "tv" && episodes.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide">Season {season} Episodes</h2>
            <button
              onClick={toggleHideWatched}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                hideWatched ? "bg-accent/20 text-accent" : "bg-surface text-text-muted hover:text-foreground hover:bg-surface-hover"
              }`}
              aria-pressed={hideWatched}
            >
              Hide watched
            </button>
          </div>
          {visibleEpisodes.length === 0 ? (
            <p className="text-xs text-text-muted">All episodes watched</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
              {visibleEpisodes.map((ep) => {
                const isActive = ep.episode_number === episode;
                const isWatched = !isActive && isEpisodeWatched(ep.episode_number);
                return (
                  <button
                    key={ep.episode_number}
                    onClick={() => goEp(season, ep.episode_number)}
                    className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                      isActive
                        ? "bg-accent text-white font-bold shadow-md shadow-accent/20"
                        : isWatched
                          ? "bg-red-600/20 text-red-600 border border-red-600/30"
                          : "bg-surface hover:bg-surface-hover text-text-muted hover:text-foreground"
                    }`}
                  >
                    <span className="font-semibold">EP {ep.episode_number}</span>
                    <span className="mx-1.5 text-text-secondary">—</span>
                    <span className="truncate">{ep.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Seasons list for TV shows */}
      {type === "tv" && seasons.filter((s) => s.season_number > 0).length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">Seasons</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
            {seasons.filter((s) => s.season_number > 0).map((s) => {
              const isCurrent = s.season_number === season;
              const isPrequel = s.season_number < season;
              const isSequel = s.season_number > season;
              return (
                <button
                  key={s.season_number}
                  onClick={() => goEp(s.season_number, 1)}
                  className={`text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                    isCurrent
                      ? "bg-accent text-white font-bold shadow-md shadow-accent/20"
                      : "bg-surface hover:bg-surface-hover text-text-muted hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {isPrequel && <span className="text-[9px] px-1 py-0.5 rounded-full bg-text-secondary/20 text-text-secondary font-semibold">Prequel</span>}
                    {isSequel && <span className="text-[9px] px-1 py-0.5 rounded-full bg-accent/20 text-accent font-semibold">Sequel</span>}
                    {isCurrent && <span className="text-[9px] px-1 py-0.5 rounded-full bg-accent/30 text-white font-bold">Current</span>}
                  </div>
                  <span className="font-semibold">Season {s.season_number}</span>
                  <span className="mx-1.5 text-text-secondary">—</span>
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
