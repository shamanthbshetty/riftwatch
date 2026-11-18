"use client";

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams, useRouter, useParams } from "next/navigation";
import Link from "next/link";
import VideoPlayer from "@/components/VideoPlayer";
import IframePlayer from "@/components/IframePlayer";
import SubDubToggle from "@/components/SubDubToggle";
import WatchlistStatusButton, { STATUS_LABELS } from "@/components/WatchlistStatusButton";

import { addToHistory, getLastWatched, getWatchlist, addToWatchlist, removeFromWatchlist, setWatchlistStatus, setAutoplayPref, setSkipPref, type WatchStatus } from "@/lib/storage";
import { sameShow } from "@/lib/show-id";
import { useWatchlistItems, useWatchedUpTo, useAutoplayPref, useSkipPref } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";

interface Source {
  sourceName: string;
  sourceUrl: string;
  type: string;
  isEmbed?: boolean;
  streamUrl?: string;
  subtitles?: { label: string; url: string; srclang?: string }[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  downloads?: { sourceName: string; downloadUrl: string };
}

interface ShowInfo {
  /** Canonical id (/api/episodes _id) — used for watchlist identity. */
  _id: string;
  name: string;
  englishName?: string;
  thumbnail: string;
  malId: string;
  sub: number;
  dub: number;
  allSubEps: number[];
  allDubEps: number[];
}

const EMPTY_SOURCES: Source[] = [];
const EMPTY_SUBTITLES: NonNullable<Source["subtitles"]> = [];
const EMPTY_TITLES: Record<string, string> = {};

interface SkipInterval {
  start: number;
  end: number;
}
interface AniskipResult {
  skipType: string;
  interval: { startTime: number; endTime: number };
}
// Skip times are crowd-sourced and effectively static per episode — one
// network call per episode per session, cached for revisits.
const skipCache = new Map<string, { intro: SkipInterval | null; outro: SkipInterval | null }>();

function WatchContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = params.id as string;
  const epParam = searchParams.get("ep");
  const modeParam = searchParams.get("mode");

  // Malformed values from the URL collapse to defaults instead of propagating:
  // ep=abc → Number → NaN poisons history math; mode=banana silently breaks
  // the sub/dub switch (and would 400 server-side).
  const ep = epParam && /^\d{1,4}(\.\d{1,2})?$/.test(epParam) ? epParam : "1";
  const mode = modeParam === "dub" ? "dub" : "sub";
  const titleParam_url = searchParams.get("title");

  const autoPlay = useAutoplayPref();
  // Page index stored WITH the series/mode it belongs to: adjusting during
  // render (the React-sanctioned "derived state" pattern) instead of in an
  // effect, so a show/mode switch starts at page 0 without a cascading effect.
  const epPageKey = `${id}|${mode}`;
  const [epPageState, setEpPageState] = useState<{ key: string; page: number }>({
    key: epPageKey,
    page: 0,
  });
  if (epPageState.key !== epPageKey) {
    setEpPageState({ key: epPageKey, page: 0 });
  }
  const epPage = epPageState.page;
  const setEpPage = (p: number) => setEpPageState({ key: epPageKey, page: p });
  const [retryKey, setRetryKey] = useState(0);
  const [epJump, setEpJump] = useState("");
  const [epUnwatched, setEpUnwatched] = useState(false);
  const EP_PAGE_SIZE = 100;
  // Auto-resume: if no ep param, check history for last watched. The guard is a
  // ref because it's bookkeeping, not something we render.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (epParam || resumedRef.current) return;
    resumedRef.current = true;
    const last = getLastWatched(id);
    if (last) {
      router.replace(`/watch/${id}?ep=${last.ep}&mode=${last.mode}${titleRef.current ? `&title=${encodeURIComponent(titleRef.current)}` : ""}`);
    }
  }, [id, epParam, router]);

  const watchlist = useWatchlistItems();
  const { toast } = useToast();

  // Series metadata is keyed by show id.
  const [episodesState, setEpisodesState] = useState<{
    id: string;
    titles: Record<string, string>;
    showInfo: ShowInfo | null;
    epError: string;
  } | null>(null);
  const meta = episodesState?.id === id ? episodesState : null;
  const showInfo = meta?.showInfo ?? null;
  const epTitles = meta?.titles ?? EMPTY_TITLES;
  const epError = meta?.epError ?? "";

  // Matched against every identity this page can prove — the entry may have
  // been added from a different surface (detail page/spotlight/schedule) that
  // used another id namespace for the same show.
  const wlEntry = showInfo
    ? watchlist.find((i) => sameShow(i, { id, canonicalId: showInfo._id || undefined, malId: showInfo.malId || undefined })) ?? null
    : null;
  const inWatchlist = wlEntry !== null;
  const wlStatus = wlEntry?.status ?? null;

  // Stream state is keyed by the full request so switching episode/mode/series
  // can never render the previous request's sources. Deliberately NOT including
  // showInfo.name: when metadata lands late that would change the key, blank the
  // player and refire the fetch (double fetch + playback restart).
  const streamKey = `${id}|${ep}|${mode}|${retryKey}`;
  // Title is only a fallback for name resolution — capture whatever is
  // available when the fetch fires, but never refetch just because it arrived.
  // Updated in an effect (refs are not render-time values).
  const titleRef = useRef<string>(titleParam_url ? decodeURIComponent(titleParam_url) : "");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    if (showInfo?.name) titleRef.current = showInfo.name;
  }, [showInfo?.name]);

  // Skip intro/outro data from AniSkip (crowd-sourced OP/ED timings), keyed by
  // MAL id + episode number. Best-effort: a miss just means no skip buttons.
  // The cache is read at render (static per key); state is only a re-render
  // trigger once a fetch lands.
  const autoSkipOn = useSkipPref();
  const malId = showInfo?.malId || null;
  const epNum = Math.round(Number(ep)) || 1;
  const skipKey = malId ? `${malId}|${epNum}` : null;
  const [, bumpSkipTick] = useState(0);
  useEffect(() => {
    if (!skipKey || skipCache.has(skipKey)) return;
    let cancelled = false;
    const [mid, epn] = skipKey.split("|");
    fetch(`https://api.aniskip.com/v2/skip-times/${mid}/${epn}?types=op&types=ed&episodeLength=1440`)
      .then((r) => (r.ok ? (r.json() as Promise<{ found: boolean; results: AniskipResult[] } | null>) : null))
      .then((j) => {
        if (cancelled) return;
        let val: { intro: SkipInterval | null; outro: SkipInterval | null } = { intro: null, outro: null };
        if (j?.found && Array.isArray(j.results)) {
          const op = j.results.find((r) => r.skipType === "op");
          const ed = j.results.find((r) => r.skipType === "ed");
          val = {
            intro: op ? { start: op.interval.startTime, end: op.interval.endTime } : null,
            outro: ed ? { start: ed.interval.startTime, end: ed.interval.endTime } : null,
          };
        }
        skipCache.set(skipKey, val);
        bumpSkipTick((t) => t + 1);
      })
      .catch(() => {
        if (cancelled) return;
        skipCache.set(skipKey, { intro: null, outro: null });
        bumpSkipTick((t) => t + 1);
      });
    return () => { cancelled = true; };
  }, [skipKey]);
  const skip = skipKey ? skipCache.get(skipKey) ?? null : null;

  const [stream, setStream] = useState<{
    key: string;
    sources: Source[];
    selection: number;
    loadError: string;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const currentStream = stream?.key === streamKey ? stream : null;
  const sources = currentStream?.sources ?? EMPTY_SOURCES;
  const selectedSource = currentStream?.selection ?? 0;
  const loadError = currentStream?.loadError ?? "";
  const loading = currentStream === null;
  const playerError = failedKey === streamKey;

  useEffect(() => {
    let cancelled = false;
    const titleParam = titleRef.current
      ? `&title=${encodeURIComponent(titleRef.current)}`
      : (() => {
          try {
            const c = JSON.parse(localStorage.getItem(`rw:show:${id}`) || "null");
            if (c?.name) return `&title=${encodeURIComponent(c.name)}`;
            const wl = getWatchlist().find((w) => w.id === id);
            if (wl?.title) return `&title=${encodeURIComponent(wl.title)}`;
            const last = getLastWatched(id);
            if (last?.title) return `&title=${encodeURIComponent(last.title)}`;
            return "";
          } catch { return ""; }
        })();
    // retry=N (server skips the negative cache for N >= 1): the Retry button
    // must re-run the providers, not replay the cached 502 that failed it.
    fetch(`/api/stream?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}&mode=${mode}${titleParam}&retry=${retryKey}`)
      .then((r) => r.json())
      .then((data: { embedUrl?: string; serverName?: string; sourceUrls?: Source[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          const notFound =
            data.error.includes("not found") ||
            data.error.includes("Could not resolve") ||
            data.error.includes("Invalid ID");
          setEpisodesState((prev) =>
            prev && prev.id === id
              ? { ...prev, epError: notFound ? data.error! : prev.epError }
              : prev
          );
          setStream({ key: streamKey, sources: EMPTY_SOURCES, selection: 0, loadError: notFound ? "" : data.error });
          return;
        }
        if (data.embedUrl) {
          setStream({
            key: streamKey,
            sources: [{ sourceName: data.serverName || "Server", sourceUrl: data.embedUrl, type: "text/html", isEmbed: true }],
            selection: 0,
            loadError: "",
          });
          return;
        }
        if (!data.sourceUrls || data.sourceUrls.length === 0) {
          setStream({ key: streamKey, sources: EMPTY_SOURCES, selection: 0, loadError: "No playable sources returned" });
          return;
        }
        setStream({ key: streamKey, sources: data.sourceUrls, selection: 0, loadError: "" });
      })
      .catch((e) => {
        if (!cancelled) setStream({ key: streamKey, sources: EMPTY_SOURCES, selection: 0, loadError: String(e) });
      });
    return () => {
      cancelled = true;
    };
    // showInfo?.name intentionally excluded: title is a fallback only, and
    // letting it retrigger the effect caused a double fetch mid-playback.
  }, [id, ep, mode, retryKey, streamKey]);

  // Resolve the chosen source into a playable URL.
  const streamUrl = useMemo(() => {
    const src = sources[selectedSource];
    if (!src) return "";
    let url = src.sourceUrl;
    if (url.startsWith("//")) url = "https:" + url;
    if (src.streamUrl) {
      // Direct HLS stream (with subtitle tracks) — already proxied by the source.
      return src.streamUrl;
    }
    if (src.isEmbed) {
      // ponytail: embed pages run their own JS — can't be proxied as video, use direct iframe
      return url;
    }
    const referer =
      src.sourceName === "Mp4" ? "https://mp4upload.com/"
      : src.sourceName === "Fm-Hls" ? "https://bysekoze.com/"
      : src.sourceName === "Uni" ? "https://watchanime.uns.bio/"
      : "";
    return `/api/proxy?src=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;
  }, [sources, selectedSource]);

  // Source failover: when a source errors, try the next one.
  // Two guards: (1) hls.js can emit two fatal errors in the same tick — two
  // separate setStream bumps would skip a source, so dedupe on 300ms; (2) the
  // decision is computed once outside the setState updater to keep it pure.
  const streamMirrorRef = useRef(stream);
  useEffect(() => {
    streamMirrorRef.current = stream;
  }, [stream]);
  const lastFailRef = useRef<{ key: string; ts: number } | null>(null);
  const autoRetryRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  const handleSourceError = useCallback(() => {
    const now = Date.now();
    if (lastFailRef.current && lastFailRef.current.key === streamKey && now - lastFailRef.current.ts < 300) {
      return;
    }
    lastFailRef.current = { key: streamKey, ts: now };
    const prev = streamMirrorRef.current;
    if (!prev || prev.key !== streamKey) return;
    const next = prev.selection + 1;
    if (next < prev.sources.length) {
      streamMirrorRef.current = { ...prev, selection: next };
      setStream(streamMirrorRef.current);
      setFailedKey(null);
    } else {
      // Sources exhausted. One silent re-resolution before the dead-end
      // panel: a transient upstream connection reset (this network resets
      // TLS connections mid-transfer) otherwise kills single-server episodes
      // until a manual Retry. Capped so a genuinely dead source can't loop.
      const base = streamKey.split("|").slice(0, 3).join("|");
      const count = autoRetryRef.current.key === base ? autoRetryRef.current.count : 0;
      if (count < 2) {
        autoRetryRef.current = { key: base, count: count + 1 };
        setFailedKey(null);
        setRetryKey((k) => k + 1);
      } else {
        setFailedKey(streamKey);
      }
    }
  }, [streamKey]);

  function selectSource(index: number) {
    const name = sources[index]?.sourceName;
    setStream((prev) => (prev && prev.key === streamKey ? { ...prev, selection: index } : prev));
    setFailedKey(null);
    if (index !== selectedSource && name) toast(`Playing from ${name}`);
  }

  useEffect(() => {
    let cancelled = false;
    const NOT_FOUND = "This anime could not be found. The link may be outdated.";
    async function loadEpisodes(attempt = 0) {
      const tp = titleRef.current
        ? `&title=${encodeURIComponent(titleRef.current)}`
        : (() => { try { const c = JSON.parse(localStorage.getItem(`rw:show:${id}`) || "null"); return c?.name ? `&title=${encodeURIComponent(c.name)}` : ""; } catch { return ""; } })();
      try {
        const r = await fetch(`/api/episodes?id=${encodeURIComponent(id)}${tp}`);
        if (!r.ok) {
          if (attempt < 2) { setTimeout(() => loadEpisodes(attempt + 1), 800); return; }
          // Try to recover a title from watchlist/history and retry once.
          if (attempt === 2) {
            let recoveredTitle = "";
            try {
              const wl = getWatchlist().find((w) => w.id === id);
              if (wl?.title) recoveredTitle = wl.title;
              else {
                const last = getLastWatched(id);
                if (last?.title) recoveredTitle = last.title;
              }
            } catch { /* ignore */ }
            if (recoveredTitle) {
              try {
                const r2 = await fetch(`/api/episodes?id=${encodeURIComponent(id)}&title=${encodeURIComponent(recoveredTitle)}`);
                if (r2.ok) {
                  const d2 = await r2.json();
                  if (d2?.name) {
                    // re-run the success path by treating d2 as d
                    // (fall through to normal handling below by assigning)
                    // We'll handle inline:
                    const allSubEps = (d2.availableEpisodesDetail?.sub ?? []).map(Number).sort((a: number, b: number) => a - b);
                    const allDubEps = (d2.availableEpisodesDetail?.dub ?? []).map(Number).sort((a: number, b: number) => a - b);
                    const info: ShowInfo = {
                      _id: d2._id ?? "",
                      name: d2.name,
                      englishName: d2.englishName,
                      thumbnail: d2.thumbnail,
                      malId: d2.malId,
                      sub: allSubEps.length,
                      dub: allDubEps.length,
                      allSubEps,
                      allDubEps,
                    };
                    if (!cancelled) {
                      setEpisodesState({ id, titles: {}, showInfo: info, epError: "" });
                      try { localStorage.setItem(`rw:show:${id}`, JSON.stringify(info)); } catch { /* ignore */ }
                    }
                    return;
                  }
                }
              } catch { /* ignore */ }
            }
          }
          // Permanent fallback: a previously loaded show stays playable even
          // when AllAnime is down (mirror rotation, DMCA, etc.).
          let cached: ShowInfo | null = null;
          try { cached = JSON.parse(localStorage.getItem(`rw:show:${id}`) || "null"); } catch { /* ignore */ }
          if (cached && !cancelled) {
            setEpisodesState({ id, titles: {}, showInfo: cached, epError: "" });
            return;
          }
          if (!cancelled) setEpisodesState({ id, titles: {}, showInfo: null, epError: NOT_FOUND });
          return;
        }
        const d = await r.json();
        if (cancelled) return;
        if (d.error || !d._id) {
          if (attempt < 2) { setTimeout(() => loadEpisodes(attempt + 1), 800); return; }
          let cached: ShowInfo | null = null;
          try { cached = JSON.parse(localStorage.getItem(`rw:show:${id}`) || "null"); } catch { /* ignore */ }
          if (cached && !cancelled) {
            setEpisodesState({ id, titles: {}, showInfo: cached, epError: "" });
            return;
          }
          if (!cancelled) setEpisodesState({ id, titles: {}, showInfo: null, epError: d.error || NOT_FOUND });
          return;
        }
        const allSubEps = (d.availableEpisodesDetail?.sub ?? []).map(Number).sort((a: number, b: number) => a - b);
        const allDubEps = (d.availableEpisodesDetail?.dub ?? []).map(Number).sort((a: number, b: number) => a - b);
        const info: ShowInfo = {
          _id: d._id ?? "",
          name: d.name,
          englishName: d.englishName,
          thumbnail: d.thumbnail,
          malId: d.malId,
          sub: allSubEps.length,
          dub: allDubEps.length,
          allSubEps,
          allDubEps,
        };
        setEpisodesState({ id, titles: {}, showInfo: info, epError: "" });
        try { localStorage.setItem(`rw:show:${id}`, JSON.stringify(info)); } catch { /* ignore */ }
        if (d.malId) {
          fetch(`/api/titles?malId=${encodeURIComponent(d.malId)}&title=${encodeURIComponent(d.englishName || d.name || "")}`)
            .then((r) => r.json())
            .then((t) => {
              if (cancelled) return;
              setEpisodesState((prev) => (prev && prev.id === id ? { ...prev, titles: t } : prev));
            })
            .catch(() => {});
        }
      } catch {
        if (!cancelled && attempt < 2) setTimeout(() => loadEpisodes(attempt + 1), 800);
        else if (!cancelled) {
          let cached: ShowInfo | null = null;
          try { cached = JSON.parse(localStorage.getItem(`rw:show:${id}`) || "null"); } catch { /* ignore */ }
          if (cached) setEpisodesState({ id, titles: {}, showInfo: cached, epError: "" });
          else setEpisodesState({ id, titles: {}, showInfo: null, epError: "Failed to load anime info. Please try again later." });
        }
      }
    }
    loadEpisodes();
    return () => { cancelled = true; };
  }, [id]);

  // History is written when playback ACTUALLY starts, not when metadata
  // lands: merely opening (or failing to load) an episode must not mark it
  // watched. `playedKeyRef` remembers which stream reported "playing";
  // `writeHistory` retries when showInfo arrives after that.
  const playedKeyRef = useRef<string | null>(null);
  const historyWrittenKeyRef = useRef<string | null>(null);
  const writeHistory = useCallback(() => {
    if (!showInfo) return;
    if (playedKeyRef.current !== streamKey) return;
    if (historyWrittenKeyRef.current === streamKey) return;
    historyWrittenKeyRef.current = streamKey;
    addToHistory({
      id,
      title: showInfo.name,
      englishName: showInfo.englishName,
      thumbnail: showInfo.thumbnail,
      malId: showInfo.malId,
      ep: Number(ep),
      mode,
    });
  }, [showInfo, streamKey, id, ep, mode]);
  const markPlayed = useCallback(() => {
    playedKeyRef.current = streamKey;
    writeHistory();
  }, [streamKey, writeHistory]);
  useEffect(() => {
    writeHistory();
  }, [writeHistory]);

  const watchedUpTo = useWatchedUpTo(showInfo?._id || id, mode);


  const goTo = useCallback((newEp: number, newMode: "sub" | "dub") => {
    // Mark every episode up to the one being opened as watched, so the grid
    // reflects "done" immediately instead of waiting for playback to start.
    if (showInfo) {
      addToHistory({
        id: showInfo._id || id,
        title: showInfo.name,
        englishName: showInfo.englishName,
        thumbnail: showInfo.thumbnail,
        malId: showInfo.malId ?? "",
        ep: Number(newEp),
        mode: newMode,
      });
    }
    router.push(`/watch/${id}?ep=${newEp}&mode=${newMode}${titleRef.current ? `&title=${encodeURIComponent(titleRef.current)}` : ""}`);
  }, [id, router, showInfo]);

  // Manual next (button/pill) works with Auto OFF — auto-advance is gated at
  // the call site via `onEnded={autoPlay ? goNext : undefined}` instead.
  const goNext = useCallback(() => {
    goTo(Number(ep) + 1, mode);
  }, [ep, mode, goTo]);

  const onModeChange = useCallback((newMode: "sub" | "dub") => {
    goTo(Number(ep), newMode);
  }, [ep, goTo]);

  function addWithStatus(status: WatchStatus) {
    if (!showInfo) {
      toast("Title details still loading");
      return;
    }
    // Store under the canonical id (survives every route), replacing any
    // legacy entry saved under another namespace — otherwise the same show
    // ends up as two watchlist cards.
    const canonicalId = showInfo._id || id;
    if (wlEntry && wlEntry.id !== canonicalId) removeFromWatchlist(wlEntry.id);
    addToWatchlist({ id: canonicalId, title: showInfo.name, englishName: showInfo.englishName, thumbnail: showInfo.thumbnail, malId: showInfo.malId ?? "", lastEp: Number(ep), mode, status });
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

  const epTitle = epTitles[ep];
  const currentEp = Number(ep);

  // Auto-snap the episode tab to the one containing the currently playing
  // episode, so watching ep 350 shows the 300-400 tab instead of 1-100.
  useEffect(() => {
    if (!currentEp || !showInfo) return;
    const primary = mode === "sub" ? showInfo.allSubEps : showInfo.allDubEps;
    const fallback = mode === "sub" ? showInfo.allDubEps : showInfo.allSubEps;
    const all = primary.length > 0 ? primary : fallback;
    const idx = all.indexOf(currentEp);
    if (idx < 0) return;
    const p = Math.floor(idx / 100);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEpPageState((prev) => (prev.key === epPageKey && prev.page !== p ? { key: epPageKey, page: p } : prev));
  }, [currentEp, mode, showInfo, epPageKey]);
  // Last available episode for this mode (unknown → assume a next exists).
  // Prefer the current mode's episode list; fall back to the other mode's list
  // so episodes always render even when the backend only knows sub counts.
  const epsList = (() => {
    if (!showInfo) return undefined;
    const primary = mode === "sub" ? showInfo.allSubEps : showInfo.allDubEps;
    if (primary && primary.length > 0) return primary;
    const fallback = mode === "sub" ? showInfo.allDubEps : showInfo.allSubEps;
    return fallback && fallback.length > 0 ? fallback : primary;
  })();
  const lastAvailEp = epsList && epsList.length > 0 ? epsList[epsList.length - 1] : null;
  const hasNextEp = lastAvailEp === null || currentEp < lastAvailEp;
  const nextEpLabel = `EP ${currentEp + 1}`;

  return (
    <div className="max-w-7xl mx-auto page-top pb-4 space-y-4">
      {/* Back button */}
      <button onClick={() => router.push("/")} className="text-text-muted hover:text-foreground transition-colors">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>

      {/* Player */}
      <div className="w-full">
        {epError && !showInfo ? (
          <div className="player-wrap w-full bg-black rounded-lg" style={{ aspectRatio: "16/9" }}>
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-6 text-center">
              <svg className="w-12 h-12 text-text-secondary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-medium">Anime not found</span>
              <span className="text-xs text-text-secondary max-w-xs">{epError}</span>
              <Link href="/" className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors mt-2">
                Browse Anime
              </Link>
            </div>
          </div>
        ) : loading ? (
          <div className="player-wrap w-full bg-black rounded-lg" style={{ aspectRatio: "16/9" }}>
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3">
              <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Loading sources...</span>
            </div>
          </div>
        ) : sources.length === 0 || playerError ? (
          <div className="player-wrap w-full bg-black rounded-lg" style={{ aspectRatio: "16/9" }}>
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-6 text-center">
              <svg className="w-12 h-12 text-text-secondary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span className="font-medium">{playerError ? "All sources failed" : "No sources found"}</span>
              <span className="text-xs text-text-secondary max-w-xs">This episode may be unavailable. Try switching to a different source or episode.</span>
              {loadError && <span className="text-xs text-red-500/70 max-w-md text-center break-all">{loadError}</span>}
              <button
                onClick={() => { setFailedKey(null); setRetryKey((k) => k + 1); }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-surface hover:bg-surface-hover text-text-muted border border-border transition-colors btn-tap"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          streamUrl && (
            sources[selectedSource]?.isEmbed ? (
              <IframePlayer
                src={streamUrl}
                onError={handleSourceError}
                onEnded={autoPlay ? goNext : undefined}
                onLoad={markPlayed}
              />
            ) : (
              <VideoPlayer
                key={streamUrl}
                src={streamUrl}
                type={sources[selectedSource]?.type}
                subtitles={sources[selectedSource]?.subtitles ?? EMPTY_SUBTITLES}
                onEnded={autoPlay && hasNextEp ? goNext : undefined}
                onNext={hasNextEp ? goNext : undefined}
                autoAdvance={autoPlay}
                nextTitle={epTitles[String(currentEp + 1)] ? `EP ${currentEp + 1} — ${epTitles[String(currentEp + 1)]}` : undefined}
                onError={handleSourceError}
                onFirstPlay={markPlayed}
                storageKey={`anime|${showInfo?._id || id}|${mode}|${ep}`}
                nextLabel={hasNextEp ? nextEpLabel : undefined}
                skipIntro={sources[selectedSource]?.intro ?? skip?.intro ?? null}
                skipOutro={sources[selectedSource]?.outro ?? skip?.outro ?? null}
                autoSkip={autoSkipOn}
              />
            )
          )
        )}
      </div>

      {/* Source selector */}
      {sources.length >= 1 && (
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
                {s.sourceName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold">{showInfo?.englishName || showInfo?.name}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-text-muted">
              Episode {ep}{epTitle ? ` — ${epTitle}` : ""}
            </span>
            <span className="text-xs text-text-secondary bg-surface px-2 py-0.5 rounded">{mode.toUpperCase()}</span>
            {showInfo && (showInfo.sub > 0 || showInfo.dub > 0) && (
              <SubDubToggle mode={mode} onChange={onModeChange} subCount={showInfo.sub} dubCount={showInfo.dub} />
            )}
          </div>
        </div>
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
            onClick={() => setSkipPref(!autoSkipOn)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              autoSkipOn ? "bg-accent/20 text-accent" : "bg-surface text-text-muted"
            }`}
            title="Automatically skip openings and endings when skip times are available"
          >
            Auto Skip {autoSkipOn ? "ON" : "OFF"}
          </button>
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

      {/* Download link */}
      {(sources[selectedSource]?.downloads?.downloadUrl) && (
        <a
          href={sources[selectedSource].downloads!.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download from {sources[selectedSource].downloads!.sourceName}
        </a>
      )}

      {/* Episode list */}
      {showInfo && (() => {
        const primaryEps = mode === "sub" ? showInfo.allSubEps : showInfo.allDubEps;
        const fallbackEps = mode === "sub" ? showInfo.allDubEps : showInfo.allSubEps;
        const allEps = primaryEps.length > 0 ? primaryEps : fallbackEps;
        if (allEps.length === 0) return null;
        // Filter first — paging, the jump box and the count all follow the
        // filtered list so the toolbar can't point at a hidden episode.
        const eps = epUnwatched && watchedUpTo > 0
          ? allEps.filter((n) => n > watchedUpTo || n === currentEp)
          : allEps;
        const totalPages = Math.ceil(eps.length / EP_PAGE_SIZE);
        // Clamp: the dub list can be shorter than the sub list, so a page index
        // that was valid a render ago may now be out of range.
        const page = Math.min(epPage, Math.max(0, totalPages - 1));
        const start = page * EP_PAGE_SIZE;
        const visible = eps.slice(start, start + EP_PAGE_SIZE);
        const currentOnDifferentPage = !visible.includes(currentEp) && totalPages > 1;
        const hasUnwatched = watchedUpTo > 0 && allEps.some((n) => n > watchedUpTo);

        function submitJump(e: React.FormEvent) {
          e.preventDefault();
          const n = Number.parseInt(epJump, 10);
          if (!Number.isFinite(n) || !allEps.includes(n)) return;
          if (!eps.includes(n)) setEpUnwatched(false);
          setEpPage(Math.floor(allEps.indexOf(n) / EP_PAGE_SIZE));
          setEpJump("");
          goTo(n, mode); // eslint-disable-line react-hooks/refs
        }

        return (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide">Episodes</h2>
              <span className="text-xs text-text-muted tabular-nums">
                {eps.length === allEps.length ? `${allEps.length} eps` : `${eps.length} of ${allEps.length} eps`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <form onSubmit={submitJump} className="flex items-center gap-1.5">
                <label htmlFor="ep-jump" className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
                  Jump to ep
                </label>
                <input
                  id="ep-jump"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={epJump}
                  onChange={(e) => setEpJump(e.target.value)}
                  placeholder={String(allEps[allEps.length - 1])}
                  className="w-16 rounded-control border border-border bg-surface px-2 py-1.5 text-xs tabular-nums text-foreground placeholder:text-text-secondary focus:border-accent/50 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!epJump}
                  className="rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
                >
                  Go
                </button>
              </form>
              {hasUnwatched && (
                <button
                  type="button"
                  aria-pressed={epUnwatched}
                  onClick={() => setEpUnwatched((v) => !v)}
                  className={`rounded-chip border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    epUnwatched
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border bg-surface text-text-muted hover:text-foreground"
                  }`}
                >
                  Unwatched only
                </button>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 flex-wrap">
                {Array.from({ length: totalPages }, (_, i) => {
                  const lo = i * EP_PAGE_SIZE + 1;
                  const hi = Math.min((i + 1) * EP_PAGE_SIZE, eps.length);
                  return (
                    <button
                      key={i}
                      onClick={() => setEpPage(i)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border ${
                        i === page
                          ? "bg-accent text-white border-accent shadow-md shadow-accent/20"
                          : "bg-surface text-text-muted border-border hover:border-accent/40 hover:text-foreground"
                      }`}
                    >
                      {lo}–{hi}
                    </button>
                  );
                })}
                {currentOnDifferentPage && (
                  <button
                    onClick={() => setEpPage(Math.floor(allEps.indexOf(currentEp) / EP_PAGE_SIZE))}
                    className="px-3 py-1.5 rounded-full text-xs font-medium bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 transition-colors"
                  >
                    Jump to Ep {currentEp}
                  </button>
                )}
              </div>
            )}
            {eps.length === 0 && (
              <p className="rounded-control border border-border bg-surface px-3 py-4 text-center text-xs text-text-secondary">
                You&apos;ve watched every available episode.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {visible.map((epNum) => {
                const isActive = epNum === currentEp;
                const isWatched = watchedUpTo > 0 && epNum <= watchedUpTo && !isActive;
                const title = epTitles[String(epNum)];
                return (
                  <button
                    key={epNum}
                    onClick={() => goTo(epNum, mode)}
                    className={`group relative flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                      isActive
                        ? "bg-accent/15 border-accent shadow-lg shadow-accent/10"
                        : isWatched
                          ? "bg-surface/50 border-border/40 opacity-75 hover:opacity-100"
                          : "bg-surface border-border hover:border-accent/40 hover:bg-surface-hover"
                    }`}
                  >
                    <span className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold tabular-nums ${
                      isActive ? "bg-accent text-white" : isWatched ? "bg-emerald-500/15 text-emerald-500" : "bg-surface-hover text-foreground/80"
                    }`}>
                      {epNum}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[11px] font-semibold uppercase tracking-wider ${isActive ? "text-accent" : "text-text-muted"}`}>
                          Episode {epNum}
                        </span>
                        {isWatched && (
                          <svg className="w-3 h-3 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      {title && (
                        <p className={`text-xs leading-snug line-clamp-1 mt-0.5 ${isActive ? "text-accent/80" : "text-text-muted"}`}>
                          {title}
                        </p>
                      )}
                    </div>
                    {isActive && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-accent flex-shrink-0">Now</span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })()}
    </div>
  );
}

export default function WatchPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto page-top pb-4">
          <div className="player-wrap w-full bg-black rounded-lg" style={{ aspectRatio: "16/9" }}>
            <div className="flex items-center justify-center h-full">
              <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          </div>
        </div>
      }
    >
      <WatchContent />
    </Suspense>
  );
}
