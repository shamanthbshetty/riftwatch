"use client";

import { useEffect, useState, use } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import SubDubToggle from "@/components/SubDubToggle";
import EpisodeList from "@/components/EpisodeList";
import WatchlistStatusButton, { STATUS_LABELS } from "@/components/WatchlistStatusButton";
import { addToWatchlist, removeFromWatchlist, setWatchlistStatus, formatMediaTime, type WatchStatus } from "@/lib/storage";
import { useWatchlistItems, useShowResume } from "@/lib/useWatchlists";
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
  const inWatchlist = watchlist.some((i) => i.id === id);
  const wlStatus = watchlist.find((i) => i.id === id)?.status ?? null;
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

  const current = loaded?.key === key ? loaded : null;
  const show = current?.show ?? null;
  const titles = current?.titles ?? EMPTY_TITLES;
  const schedule = current?.schedule ?? null;
  const relations = current?.relations ?? [];
  const loading = current === null;
  const descExpanded = expandedKey === key;

  useEffect(() => {
    let cancelled = false;
    const empty: Record<string, string> = {};

    fetch(`/api/episodes?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((data: ShowDetail & { error?: string }) => {
        if (cancelled) return;
        if (!data.error && data._id) {
          if ((data.availableEpisodesDetail?.dub ?? []).length === 0) setMode("sub");
          // Publish the show immediately, then enrich it with titles/schedule/relations.
          setLoaded({ key, show: data, titles: empty, schedule: null, relations: [] });
          if (data.malId) {
            void fetch(`/api/titles?malId=${encodeURIComponent(data.malId)}`)
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
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, show: null, titles: empty, schedule: null, relations: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [id, key]);

  function addWithStatus(status: WatchStatus) {
    if (!show) return;
    addToWatchlist({
      id,
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
    setWatchlistStatus(id, status);
    toast(`Marked as ${STATUS_LABELS[status]}`);
  }

  function removeFromList() {
    removeFromWatchlist(id);
    toast("Removed from watchlist");
  }

  function selectEpisode(ep: number) {
    router.push(`/watch/${id}?ep=${ep}&mode=${mode}${show?.name ? `&title=${encodeURIComponent(show.name)}` : ""}`);
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto pt-[80px] pb-8">
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
    <div className="max-w-7xl mx-auto pt-[80px] pb-8 text-center space-y-4">
      <div className="mb-4">
        <svg className="w-16 h-16 mx-auto text-text-secondary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <p className="text-text-muted font-medium">Anime not found</p>
      <p className="text-text-secondary text-sm">This show might be unavailable or the ID is invalid.</p>
      <button
        onClick={() => setRetryKey((k) => k + 1)}
        className="px-4 py-2 rounded-lg text-sm font-medium bg-surface hover:bg-surface-hover text-text-muted border border-border transition-colors btn-tap"
      >
        Try Again
      </button>
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
    <div className="max-w-7xl mx-auto pt-[80px] pb-6 space-y-8">
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
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold">Episodes</h2>
          <span className="text-sm text-text-muted">{mode.toUpperCase()} &middot; {episodes.length} eps</span>
        </div>
        <EpisodeList
          episodes={episodes}
          mode={mode}
          titles={titles}
          onSelect={selectEpisode}
        />
      </section>

      {/* Related: prequel/sequel/etc as a horizontal rail below the episodes. */}
      {relations.length > 0 && (
        <section aria-label="Related anime">
          <h2 className="text-lg font-semibold mb-4">Related</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {relations.map((r) => (
              <Link
                key={`${r.relation}-${r.id}`}
                href={`/anime/${r.id}`}
                className="group flex-shrink-0 w-32 md:w-36"
                title={`${RELATION_LABELS[r.relation] ?? r.relation} — ${r.title}`}
              >
                <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface">
                  {r.thumbnail ? (
                    <Image
                      src={r.thumbnail}
                      alt={r.title}
                      fill
                      sizes="(max-width: 768px) 128px, 144px"
                      className="object-cover transition-transform duration-300 group-hover:scale-105"
                      unoptimized
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute top-1.5 left-1.5">
                    <span className="text-[9px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full">
                      {RELATION_LABELS[r.relation] ?? r.relation}
                    </span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 p-2">
                    <p className="text-[11px] font-semibold text-white line-clamp-2 leading-tight">{r.title}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
