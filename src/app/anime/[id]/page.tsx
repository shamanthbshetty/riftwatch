"use client";

import { useEffect, useState, use } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import SubDubToggle from "@/components/SubDubToggle";
import EpisodeList from "@/components/EpisodeList";
import MediaCard from "@/components/MediaCard";
import Rail from "@/components/Rail";
import SectionHeader from "@/components/SectionHeader";
import EmptyState from "@/components/Skeleton";
import WatchlistStatusButton, { STATUS_LABELS } from "@/components/WatchlistStatusButton";
import { addToWatchlist, removeFromWatchlist, setWatchlistStatus, addToHistory, formatMediaTime, type WatchStatus } from "@/lib/storage";
import { useWatchlistItems, useShowResume, useWatchedUpTo } from "@/lib/useWatchlists";
import { sameShow } from "@/lib/show-id";
import { useToast } from "@/lib/toast";

interface ShowDetail {
  _id: string;
  name: string;
  englishName?: string;
  malId: string;
  thumbnail: string;
  description: string;
  status: string;
  score: number;
  genres: string[];
  availableEpisodes: { sub: number; dub: number };
  availableEpisodesDetail: { sub: string[]; dub: string[] };
}

interface Schedule {
  status: string;
  nextEpisode: { episode: number; title: string } | null;
}

interface Relation {
  id: number;
  relation: string;
  title: string;
  thumbnail: string;
}

const RELATION_LABELS: Record<string, string> = {
  SEQUEL: "Sequel",
  PREQUEL: "Prequel",
  PARENT: "Parent",
  SIDE_STORY: "Side story",
  SPIN_OFF: "Spin-off",
  ALTERNATIVE: "Alternative",
};

const EMPTY_TITLES: Record<string, string> = {};

export default function AnimeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const [mode, setMode] = useState<"sub" | "dub">("sub");
  const [retryKey, setRetryKey] = useState(0);
  const watchlist = useWatchlistItems();
  const resume = useShowResume(id);
  const { toast } = useToast();

  // Data is tagged with the request that produced it, so a navigation to another
  // show can never render the previous show's rows while the new ones load.
  const key = `${id}|${retryKey}|${pathname}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    show: ShowDetail | null;
    titles: Record<string, string>;
    schedule: Schedule | null;
    relations: Relation[];
  } | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [trailerState, setTrailerState] = useState<{
    seed: string;
    key: string | null;
    done: boolean;
  } | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);

  const current = loaded?.key === key ? loaded : null;
  const show = current?.show ?? null;
  const trailerSeed = show?.malId || id;
  const trailerLookupable = Boolean(
    show?.malId || /^\d+$/.test(id) || show?.englishName || show?.name,
  );
  const trailerReady = trailerState?.seed === trailerSeed ? trailerState : null;
  const trailerKey = trailerReady?.key ?? null;
  const trailerDone = trailerReady?.done ?? !trailerLookupable;
  const watchedUpTo = useWatchedUpTo(show?._id || id, mode);
  const titles = current?.titles ?? EMPTY_TITLES;
  const schedule = current?.schedule ?? null;
  const relations = current?.relations ?? [];
  const loading = current === null;
  const descExpanded = expandedKey === key;

  // Matched against every identity this page can prove (route id, canonical
  // id, MAL id) — the entry may have been added from a different surface
  // (spotlight/schedule/search) that used a different id for the same show.
  const wlEntry = show
    ? watchlist.find((i) => sameShow(i, { id, canonicalId: show._id, malId: show.malId })) ?? null
    : null;
  const inWatchlist = wlEntry !== null;
  const wlStatus = wlEntry?.status ?? null;

  useEffect(() => {
    let cancelled = false;
    const empty: Record<string, string> = {};
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Upstream lookups (AllAnime/AniList) are occasionally rate-limited. A
    // single 502 used to render "Anime not found" for a show that exists, so
    // retry twice before declaring the page unavailable.
    async function loadShow(attempt = 0) {
      try {
        const r = await fetch(`/api/episodes?id=${encodeURIComponent(id)}`);
        if (cancelled) return;
        if (!r.ok) {
          if (attempt < 2) {
            timers.push(setTimeout(() => loadShow(attempt + 1), 800));
            return;
          }
          setLoaded({ key, show: null, titles: empty, schedule: null, relations: [] });
          return;
        }
        const data: ShowDetail & { error?: string } = await r.json();
        if (cancelled) return;
        if (!data.error && data._id) {
          if ((data.availableEpisodesDetail?.dub ?? []).length === 0) setMode("sub");
          // Publish the show immediately, then enrich it with titles/schedule/relations.
          setLoaded({ key, show: data, titles: empty, schedule: null, relations: [] });
          if (data.malId) {
            void fetch(`/api/titles?malId=${encodeURIComponent(data.malId)}&title=${encodeURIComponent(data.englishName || data.name || "")}`)
              .then((r) => r.json())
              .then((t) => {
                if (cancelled) return;
                setLoaded((prev) => (prev?.key === key ? { ...prev, titles: t } : prev));
              })
              .catch(() => {});
            void fetch(`/api/jikan-anime?malId=${encodeURIComponent(data.malId)}`)
              .then((r) => r.json())
              .then((s) => {
                if (cancelled) return;
                setLoaded((prev) => (prev?.key === key ? { ...prev, schedule: s } : prev));
              })
              .catch(() => {});
            void fetch(`/api/relations?malId=${encodeURIComponent(data.malId)}`)
              .then((r) => r.json())
              .then((d: { relations?: Relation[] }) => {
                if (cancelled || !d.relations?.length) return;
                setLoaded((prev) => (prev?.key === key ? { ...prev, relations: d.relations! } : prev));
              })
              .catch(() => {});
          } else if (/^\d+$/.test(id)) {
            // Spotlight entries carry AniList ids but no MAL id yet.
            void fetch(`/api/relations?id=${encodeURIComponent(id)}`)
              .then((r) => r.json())
              .then((d: { relations?: Relation[] }) => {
                if (cancelled || !d.relations?.length) return;
                setLoaded((prev) => (prev?.key === key ? { ...prev, relations: d.relations! } : prev));
              })
              .catch(() => {});
          }
          return;
        }
        setLoaded({ key, show: null, titles: empty, schedule: null, relations: [] });
      } catch {
        if (cancelled) return;
        if (attempt < 2) {
          timers.push(setTimeout(() => loadShow(attempt + 1), 800));
          return;
        }
        setLoaded({ key, show: null, titles: empty, schedule: null, relations: [] });
      }
    }

    loadShow();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [id, key]);

  // Trailer (AniList first, TMDB fallback handled by the API)
  useEffect(() => {
    let cancelled = false;
    const seed = show?.malId || id;
    const title = show?.englishName || show?.name || "";
    const fetchTrailer = (params: string) =>
      fetch(`/api/anime/trailer?${params}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const k = d?.site === "youtube" && d?.id ? d.id : null;
          setTrailerState({ seed, key: k, done: true });
        })
        .catch(() => {
          if (!cancelled) setTrailerState({ seed, key: null, done: true });
        });
    const params = new URLSearchParams();
    if (show?.malId) params.set("malId", show.malId);
    else if (/^\d+$/.test(id)) params.set("id", id);
    if (title) params.set("title", title);
    if (params.toString()) fetchTrailer(params.toString());
    return () => {
      cancelled = true;
    };
  }, [show?.malId, show?.englishName, show?.name, id]);

  function addWithStatus(status: WatchStatus) {
    if (!show) return;
    // Store under the canonical id (survives every route), replacing any
    // legacy entry saved under another namespace — otherwise the same show
    // ends up as two watchlist cards.
    const canonicalId = show._id || id;
    if (wlEntry && wlEntry.id !== canonicalId) removeFromWatchlist(wlEntry.id);
    addToWatchlist({
      id: canonicalId,
      title: show.name,
      englishName: show.englishName,
      thumbnail: show.thumbnail,
      malId: show.malId ?? "",
      lastEp: 0,
      mode,
      status,
    });
    toast(`Added as ${STATUS_LABELS[status]}`, "success");
  }

  function changeStatus(status: WatchStatus) {
    if (!wlEntry) return;
    setWatchlistStatus(wlEntry.id, status);
    toast(`Marked as ${STATUS_LABELS[status]}`);
  }

  function removeFromList() {
    if (!wlEntry) return;
    removeFromWatchlist(wlEntry.id);
    toast("Removed from watchlist");
  }

  function selectEpisode(ep: number) {
    if (show) {
      addToHistory({
        id: show._id || id,
        title: show.name,
        englishName: show.englishName,
        thumbnail: show.thumbnail,
        malId: show.malId ?? "",
        ep: Number(ep),
        mode,
      });
    }
    router.push(`/watch/${id}?ep=${ep}&mode=${mode}${show?.name ? `&title=${encodeURIComponent(show.name)}` : ""}`);
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto page-top pb-8">
        <div className="flex flex-col md:flex-row gap-6">
          <div className="w-full md:w-72 aspect-[3/4] rounded-lg bg-surface skeleton" />
          <div className="flex-1 space-y-4">
            <div className="h-8 w-64 bg-surface rounded-lg skeleton" />
            <div className="h-4 w-40 bg-surface rounded-lg skeleton" />
            <div className="h-20 bg-surface rounded-lg skeleton" />
          </div>
        </div>
      </div>
    );
  }

  if (!show) return (
    <div className="max-w-7xl mx-auto page-top pb-8 text-center space-y-4">
      <EmptyState
        icon={
          <svg className="h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
        title="Couldn't load this anime"
        description="This show may be unavailable right now, or the ID is invalid."
        action={
          <button
            onClick={() => setRetryKey((k) => k + 1)}
            className="rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-hover btn-tap"
          >
            Try Again
          </button>
        }
      />
    </div>
  );

  const episodes = mode === "sub"
    ? (show.availableEpisodesDetail?.sub ?? []).map(Number).sort((a, b) => a - b)
    : (show.availableEpisodesDetail?.dub ?? []).map(Number).sort((a, b) => a - b);

  const subCount = (show.availableEpisodesDetail?.sub ?? []).length;
  const dubCount = (show.availableEpisodesDetail?.dub ?? []).length;

  const firstEp = episodes[0] ?? 1;

  // Only honour the saved position when that episode still exists in its own
  // mode's list — a stale dub position shouldn't hijack a sub-only catalogue.
  const resumeTarget =
    resume && (show.availableEpisodesDetail?.[resume.mode] ?? []).map(Number).includes(resume.ep) ? resume : null;

  return (
    <div className="max-w-7xl mx-auto page-top pb-6 space-y-8">
      {/* Back button */}
      <button onClick={() => router.back()} className="text-text-muted hover:text-foreground transition-colors">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>
      {/* Hero section */}
      <div className="relative">
        <div className="absolute inset-0 bg-gradient-to-b from-surface/50 to-transparent rounded-xl -z-10" />
        <div className="flex flex-col md:flex-row gap-6 p-6">
          <div className="relative w-full md:w-56 aspect-[3/4] rounded-lg overflow-hidden shadow-2xl shadow-black/50 shrink-0 bg-surface">
            {show.thumbnail && <Image src={show.thumbnail} alt={show.name} fill className="object-cover" unoptimized />}
          </div>
          <div className="flex-1 space-y-4">
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">{show.englishName || show.name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {show.score > 0 && (
                <span className="bg-badge-sub/20 text-badge-sub px-2 py-0.5 rounded text-xs font-semibold">
                  MAL {show.score}
                </span>
              )}
              {/not yet released/i.test(show.status) ? (
                <span className="bg-amber-500/20 text-amber-500 px-2 py-0.5 rounded text-xs font-semibold">
                  Upcoming
                </span>
              ) : (
                show.status && (
                  <span className="bg-surface px-2 py-0.5 rounded text-xs text-text-muted">{show.status}</span>
                )
              )}
              {subCount > 0 && (
                <span className="bg-badge-sub/20 text-badge-sub px-2 py-0.5 rounded text-xs font-semibold">
                  SUB {subCount}
                </span>
              )}
              {dubCount > 0 && (
                <span className="bg-badge-dub/20 text-badge-dub px-2 py-0.5 rounded text-xs font-semibold">
                  DUB {dubCount}
                </span>
              )}
              {schedule?.nextEpisode && (
                <span className="bg-accent/20 text-accent px-2 py-0.5 rounded text-xs font-semibold">
                  Next: Ep {schedule.nextEpisode.episode}{schedule.nextEpisode.title ? ` — ${schedule.nextEpisode.title}` : ""}
                </span>
              )}
            </div>
            {show.genres?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {show.genres.map((g) => (
                  <span key={g} className="text-xs bg-surface-hover px-2.5 py-1 rounded-full text-text-muted">{g}</span>
                ))}
              </div>
            )}
            {show.description && (
              <p
                onClick={() => setExpandedKey(descExpanded ? null : key)}
                className={`text-sm text-text-muted leading-relaxed cursor-pointer hover:text-foreground transition-colors ${descExpanded ? "" : "line-clamp-4"}`}
              >
                {show.description}
              </p>
            )}
            <div className="flex items-center gap-3 pt-2">
              {episodes.length > 0 ? (
                <button
                  onClick={() =>
                    resumeTarget
                      ? router.push(`/watch/${id}?ep=${resumeTarget.ep}&mode=${resumeTarget.mode}${show?.name ? `&title=${encodeURIComponent(show.name)}` : ""}`)
                      : selectEpisode(firstEp)
                  }
                  className="bg-accent hover:bg-accent-hover text-white px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
                >
                  {resumeTarget
                    ? `Continue · E${resumeTarget.ep} · ${formatMediaTime(resumeTarget.t)}`
                    : "Watch Now"}
                </button>
              ) : (
                <span className="px-6 py-2.5 rounded-lg text-sm font-semibold bg-surface border border-border text-text-muted">
                  No episodes yet
                </span>
              )}
              <SubDubToggle
                mode={mode}
                onChange={setMode}
                subCount={subCount}
                dubCount={dubCount}
              />
              <button
                type="button"
                onClick={() => setTrailerOpen(true)}
                className="inline-flex items-center gap-2 bg-surface-hover hover:bg-border text-foreground px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors border border-border"
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
          </div>
        </div>
      </div>

      {/* Episodes */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Episodes</h2>
          <span className="text-xs font-medium text-text-muted bg-surface border border-border rounded-full px-3 py-1 tabular-nums">
            {mode.toUpperCase()} · {episodes.length} eps
          </span>
        </div>
        <EpisodeList
          episodes={episodes}
          mode={mode}
          titles={titles}
          watchedUpTo={watchedUpTo}
          onSelect={selectEpisode}
        />
      </section>

      {/* Related: prequel/sequel/etc as a horizontal rail below the episodes. */}
      {relations.length > 0 && (
        <section aria-label="Related anime">
          <SectionHeader title="Related" note="Sequels, prequels and spin-offs" />
          <Rail itemCount={Math.min(relations.length, 12)}>
            {relations.slice(0, 12).map((r) => (
              <MediaCard
                key={`${r.relation}-${r.id}`}
                href={`/anime/${r.id}`}
                title={r.title}
                image={r.thumbnail}
                meta={[RELATION_LABELS[r.relation] ?? r.relation]}
                className="w-[168px] flex-shrink-0"
              />
            ))}
          </Rail>
        </section>
      )}

      {/* Trailer modal — portaled so the page's entrance transform cannot
          trap position:fixed inside the long page (it would center offscreen). */}
      {trailerOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setTrailerOpen(false)}
          >
            <div
              className="relative w-full max-w-[min(100%,142vh)] aspect-video mx-auto"
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
                  <p className="text-sm">No official trailer on AniList or TMDB.</p>
                  <a
                    href={`https://www.youtube.com/results?search_query=${encodeURIComponent((show?.englishName || show?.name || "") + " trailer")}`}
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
