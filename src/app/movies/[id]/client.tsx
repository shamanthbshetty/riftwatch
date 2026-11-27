"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useRouteParam } from "@/lib/use-route-param";
import Link from "next/link";
import { posterUrl, backdropUrl, type MovieDetail, type MovieResult } from "@/lib/movies";
import { addToMovieWatchlist, removeFromMovieWatchlist, setMovieWatchlistStatus, formatMediaTime, type WatchStatus } from "@/lib/storage";
import { useMovieWatchlistItems, useMovieResume, useMovieSeasonWatched } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import WatchlistStatusButton, { STATUS_LABELS } from "@/components/WatchlistStatusButton";
import MovieCard from "@/components/MovieCard";
import Rail from "@/components/Rail";

const EMPTY_RECS: MovieResult[] = [];

/** Season link with a "3/7 watched" progress chip (red-tile history). */
function SeasonLink({ id, season }: { id: string; season: { season_number: number; episode_count: number } }) {
  const watched = useMovieSeasonWatched(id, season.season_number);
  return (
    <Link
      href={`/movies/${id}/watch?type=tv&season=${season.season_number}&episode=1`}
      className="inline-flex flex-col items-start gap-0.5 bg-surface hover:bg-surface-hover border border-border text-foreground font-medium px-4 py-2 rounded-lg text-sm transition-colors"
    >
      <span>Season {season.season_number}</span>
      {watched > 0 && season.episode_count > 0 && (
        <span className="text-[10px] text-accent font-semibold">
          {Math.min(watched, season.episode_count)}/{season.episode_count} watched
        </span>
      )}
    </Link>
  );
}

export default function MovieDetailPage() {
  const searchParams = useSearchParams();
  const id = useRouteParam("id");
  // Anything other than an explicit ?type=tv is a movie — the old cast let
  // garbage (type=banana) through as "banana" until the API rejected it.
  const type = searchParams.get("type") === "tv" ? "tv" : "movie";

  // Tag the payload with the request that produced it so navigating between
  // titles never flashes the previous title's data.
  const key = `${id}|${type}`;
  const [loaded, setLoaded] = useState<{ key: string; detail: MovieDetail | null } | null>(null);
  const watchlist = useMovieWatchlistItems();
  const inWatchlist = watchlist.some((i) => i.id === id);
  const wlStatus = watchlist.find((i) => i.id === id)?.status ?? null;
  const resume = useMovieResume(id);
  const { toast } = useToast();

  const current = loaded?.key === key ? loaded : null;
  const detail = current?.detail ?? null;
  const loading = current === null;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/movies/details?id=${encodeURIComponent(id)}&type=${type}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setLoaded({ key, detail: data?.error ? null : data });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, detail: null });
      });
    return () => {
      cancelled = true;
    };
  }, [id, type, key]);

  // "More Like This" — tagged with the same key so title switches never flash
  // the previous title's recommendations.
  const [recsState, setRecsState] = useState<{ key: string; list: MovieResult[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/movies/recommendations?id=${encodeURIComponent(id)}&type=${type}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRecsState({ key, list: Array.isArray(data?.results) ? data.results : [] });
      })
      .catch(() => {
        if (!cancelled) setRecsState({ key, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [id, type, key]);
  const recs = recsState?.key === key ? recsState.list : EMPTY_RECS;

  // Trailer (TMDB first, AniList fallback handled by the API)
  const [trailerState, setTrailerState] = useState<{
    key: string;
    trailer: string | null;
    done: boolean;
  } | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/movies/trailer?id=${encodeURIComponent(id)}&type=${type}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const pick = data?.site === "youtube" && data?.id ? data.id : null;
        setTrailerState({ key, trailer: pick, done: true });
      })
      .catch(() => {
        if (!cancelled) setTrailerState({ key, trailer: null, done: true });
      });
    return () => {
      cancelled = true;
    };
  }, [id, type, key]);
  const trailerReady = trailerState?.key === key ? trailerState : null;
  const trailerKey = trailerReady?.trailer ?? null;
  const trailerDone = trailerReady?.done ?? false;

  if (loading) {
    return (
      <div className="page-top">
        {/* Mirrors the loaded layout (back row + full-bleed backdrop) so the
            offset doesn't jump when detail lands. */}
        <div className="max-w-7xl mx-auto pt-4">
          <div className="w-5 h-5 rounded bg-surface skeleton" />
        </div>
        <div className="w-full h-[400px] bg-surface animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="max-w-7xl mx-auto page-top pb-16 text-center text-text-muted">
        <p>Movie not found.</p>
        <Link href="/?tab=movies" className="text-accent hover:underline mt-2 inline-block">Back to Movies</Link>
      </div>
    );
  }

  const title = detail.title || detail.name || "Untitled";
  const date = detail.release_date || detail.first_air_date;
  const year = date ? new Date(date).getFullYear() : null;
  const posterSrc = posterUrl(detail.poster_path, "w500");
  const backdrop = backdropUrl(detail.backdrop_path);

  function addWithStatus(status: WatchStatus) {
    addToMovieWatchlist({ id, title, poster: detail?.poster_path ?? "", type, status });
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

  return (
    <div className="min-h-screen page-top">
      {/* Back button */}
      <div className="max-w-7xl mx-auto pt-4">
        <Link href="/?tab=movies" className="text-text-muted hover:text-foreground transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </Link>
      </div>
      {/* Backdrop */}
      {backdrop && (
        <div className="relative w-full h-[400px] overflow-hidden">
            <Image src={backdrop} alt="" fill sizes="100vw" priority className="object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/30" />
        </div>
      )}

      <div className={`max-w-7xl mx-auto ${backdrop ? "-mt-44 relative" : "py-8"}`}>
        <div className="flex flex-col md:flex-row gap-6">
          {/* Poster */}
          {posterSrc && (
            <div className="w-48 shrink-0">
              <div className="relative aspect-[2/3] rounded-lg overflow-hidden shadow-xl shadow-black/50">
                <Image src={posterSrc} alt={title} fill className="object-cover" unoptimized />
              </div>
            </div>
          )}

          {/* Info */}
          <div className="flex-1 space-y-4">
            <div>
              <h1 className="text-2xl font-bold">{title}</h1>
              {detail.tagline && <p className="text-text-muted text-sm italic mt-1">&ldquo;{detail.tagline}&rdquo;</p>}
            </div>

            <div className="flex items-center gap-3 flex-wrap text-sm">
              {year && <span className="text-text-muted">{year}</span>}
              {detail.runtime && <span className="text-text-muted">{detail.runtime} min</span>}
              {detail.vote_average > 0 && (
                <span className="flex items-center gap-1 text-accent font-semibold">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                  {detail.vote_average.toFixed(1)}
                </span>
              )}
              <span className="px-2 py-0.5 rounded bg-surface text-text-muted text-xs uppercase">{type}</span>
              {detail.status && <span className="text-text-secondary text-xs">{detail.status}</span>}
            </div>

            {detail.genres?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.genres.map((g) => (
                  <span key={g.id} className="text-[11px] px-2 py-0.5 rounded-full bg-surface border border-border text-text-muted">
                    {g.name}
                  </span>
                ))}
              </div>
            )}

            <p className="text-sm text-text-secondary leading-relaxed">{detail.overview}</p>

            {/* Watch button */}
            <div className="flex gap-3 pt-2">
              {type === "movie" ? (
                <Link
                  href={`/movies/${detail.id}/watch?type=movie`}
                   className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  {resume?.type === "movie" ? `Continue · ${formatMediaTime(resume.t)}` : "Watch Movie"}
                </Link>
              ) : (
                <>
                  {resume?.type === "tv" && resume.season != null && resume.episode != null && (
                    <Link
                      href={`/movies/${detail.id}/watch?type=tv&season=${resume.season}&episode=${resume.episode}`}
                      className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      {`Continue · S${resume.season} E${resume.episode} · ${formatMediaTime(resume.t)}`}
                    </Link>
                  )}
                  {detail.seasons?.filter((s) => s.season_number > 0).map((s) => (
                    <SeasonLink key={s.season_number} id={String(detail.id)} season={s} />
                  ))}
                </>
              )}
              <button
                type="button"
                onClick={() => setTrailerOpen(true)}
                className="inline-flex items-center gap-2 bg-surface-hover hover:bg-border text-foreground font-semibold px-4 py-2 rounded-lg text-sm transition-colors border border-border"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                Trailer
              </button>
              <WatchlistStatusButton
                inList={inWatchlist}
                status={wlStatus}
                onAdd={addWithStatus}
                onChange={changeStatus}
                onRemove={removeFromList}
              />
            </div>

            {/* Cast */}
            {detail.cast && detail.cast.length > 0 && (
              <div className="pt-4">
                <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-2">Cast</h3>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {detail.cast.map((c) => (
                    <div key={c.id} className="flex-shrink-0 w-20 text-center">
                      <div className="relative w-16 h-16 mx-auto rounded-full overflow-hidden bg-surface mb-1">
                        {c.profile_path ? (
                          <Image src={`https://image.tmdb.org/t/p/w185${c.profile_path}`} alt={c.name} fill className="object-cover" unoptimized />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-text-secondary text-xs">
                            {c.name.charAt(0)}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-foreground font-medium truncate">{c.name}</p>
                      <p className="text-[10px] text-foreground truncate">{c.character}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* More Like This */}
      {recs.length > 0 && (
        <section className="pt-10 pb-10">
          <div className="mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
            <h2 className="text-lg font-semibold section-title">More Like This</h2>
          </div>
          <Rail itemCount={recs.length}>
            {recs.map((m) => (
              <div key={m.id} className="rail-card rail-card-wide">
                <MovieCard movie={m} showScore />
              </div>
            ))}
          </Rail>
        </section>
      )}

      {/* Trailer modal — portaled so the page's entrance transform cannot
          trap position:fixed inside the long page (it would center offscreen). */}
      {trailerOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/0"
            onClick={() => setTrailerOpen(false)}
          >
            <div
              className="relative w-full mx-auto aspect-video max-h-[calc(100vh-2rem)]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setTrailerOpen(false)}
                className="absolute top-2 right-2 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-black/60 text-white/90 hover:text-white hover:bg-black/80 transition-colors"
                aria-label="Close trailer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              {trailerKey ? (
                <iframe
                  src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1`}
                  title="Trailer"
                  className="w-full h-full rounded-lg"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              ) : !trailerDone ? (
                <div className="w-full h-full flex items-center justify-center text-white/80 p-6 text-center">
                  <p className="text-sm">Finding the trailer…</p>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-white/80 p-6 text-center">
                  <p className="text-sm">No official trailer on TMDB or AniList.</p>
                  <a
                    href={`https://www.youtube.com/results?search_query=${encodeURIComponent(title + " trailer")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-surface-hover hover:bg-border text-foreground px-4 py-2 rounded-lg text-sm font-semibold transition-colors border border-border"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    Search YouTube
                  </a>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
