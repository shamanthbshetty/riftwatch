"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getResumePos, saveResumePos } from "@/lib/storage";
import { useResumePref } from "@/lib/useWatchlists";
import {
  Captions,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

interface VideoPlayerProps {
  src: string;
  type?: string;
  subtitles?: { label: string; url: string; srclang?: string }[];
  onEnded?: () => void;
  onError?: () => void;
  onFirstPlay?: () => void;
  // Legacy props kept for call-site compatibility
  storageKey?: string;
  nextLabel?: string;
  /** Title of the following episode, shown on the up-next card. */
  nextTitle?: string;
  /** Advance to the next episode (up-next card + auto-advance countdown). */
  onNext?: () => void;
  /** Whether `onEnded` auto-advances (drives the countdown on the up-next card). */
  autoAdvance?: boolean;
  skipIntro?: { start: number; end: number } | null;
  skipOutro?: { start: number; end: number } | null;
  autoSkip?: boolean;
}

interface LevelInfo {
  index: number;
  label: string;
}

/** Progress-bar geometry of a pointer event, as a 0..1 fraction. */
function fracFromEvent(
  e: { clientX: number },
  el: HTMLElement
): number {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/* ---------- icons: lucide-react ---------- */
const Icon = {
  play: <Play className="h-6 w-6" fill="currentColor" strokeWidth={1} />,
  pause: <Pause className="h-6 w-6" fill="currentColor" strokeWidth={1} />,
  skipBack: (
    <span className="relative inline-flex">
      <RotateCcw className="h-6 w-6" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="translate-y-[2px] text-[7.5px] font-bold leading-none tabular-nums">10</span>
      </span>
    </span>
  ),
  skipFwd: (
    <span className="relative inline-flex">
      <RotateCw className="h-6 w-6" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="translate-y-[2px] text-[7.5px] font-bold leading-none tabular-nums">10</span>
      </span>
    </span>
  ),
  volHigh: <Volume2 className="h-6 w-6" />,
  volLow: <Volume1 className="h-6 w-6" />,
  muted: <VolumeX className="h-6 w-6" />,
  cc: <Captions className="h-6 w-6" />,
  gear: <Settings className="h-6 w-6" />,
  pip: <PictureInPicture2 className="h-6 w-6" />,
  fs: <Maximize className="h-6 w-6" />,
  fsExit: <Minimize className="h-6 w-6" />,
  close: <X className="h-5 w-5" />,
};
export default function VideoPlayer({
  src,
  subtitles,
  onEnded,
  onError,
  onFirstPlay,
  skipIntro,
  skipOutro,
  autoSkip,
  storageKey,
  nextLabel,
  onNext,
  nextTitle,
  autoAdvance = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resumePref = useResumePref();
  const resumePrefRef = useRef(resumePref);
  useEffect(() => { resumePrefRef.current = resumePref; }, [resumePref]);
  const storageKeyRef = useRef(storageKey);
  useEffect(() => { storageKeyRef.current = storageKey; }, [storageKey]);
  const lastSaveRef = useRef(0);
  const restoredRef = useRef(false);
  useEffect(() => { restoredRef.current = false; }, [src]);
  const reloadingRef = useRef(false);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallStartRef = useRef({ pos: 0, attempts: 0 });
  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
  }, []);
  const barRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);

  /* ------- media plumbing refs (same rationale as before: the ONLY
     re-setup triggers are src + subtitle list identity) ------- */
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const onFirstPlayRef = useRef(onFirstPlay);
  const subtitlesRef = useRef(subtitles);
  const autoSkipRef = useRef(autoSkip);
  const skipIntroRef = useRef(skipIntro);
  const skipOutroRef = useRef(skipOutro);
  useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onFirstPlayRef.current = onFirstPlay; }, [onFirstPlay]);
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);
  useEffect(() => { autoSkipRef.current = autoSkip; }, [autoSkip]);
  useEffect(() => { skipIntroRef.current = skipIntro; }, [skipIntro]);
  useEffect(() => { skipOutroRef.current = skipOutro; }, [skipOutro]);

  const subtitlesKey = useMemo(() => (subtitles ?? []).map((s) => s.url).join("|"), [subtitles]);

  /* ------- UI state ------- */
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [levelPicked, setLevelPicked] = useState(-1); // -1 = auto
  const [activeLevel, setActiveLevel] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [captionChoice, setCaptionChoice] = useState<number | null>(null);
  const [cueText, setCueText] = useState<string | null>(null);
  // Subtitle sync correction in seconds (positive = subs later). Fine-tuned
  // from the settings panel; sources occasionally ship VTTs offset from the
  // video by a constant second or two.
  const [captionOffset, setCaptionOffset] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [controlsOn, setControlsOn] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipAvailable] = useState(
    () =>
      typeof document !== "undefined" &&
      "pictureInPictureEnabled" in document &&
      document.pictureInPictureEnabled
  );
  const [scrub, setScrub] = useState<number | null>(null); // 0..1 while dragging
  const [mutedByAutoplay, setMutedByAutoplay] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [showError, setShowError] = useState(false);

  const menuOpenRef = useRef(menuOpen);
  const scrubRef = useRef(false);
  const menuScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { menuOpenRef.current = menuOpen; }, [menuOpen]);
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  /* keep url state in a ref for long-lived (empty-deps) handlers */
  const srcRef = useRef(src);
  useEffect(() => { srcRef.current = src; }, [src]);

  /* ------- main media effect: decode pipeline + custom hls config ------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    const isHls = src.includes(".m3u8");
    let cancelled = false;
    let hls: import("hls.js").default | null = null;
    let networkRecoveries = 0;
    let mediaRecoveries = 0;
    const firstPlayFired = { current: false };

    setBuffering(true);
    setShowError(false);
    setLevels([]);
    setLevelPicked(-1);
    setActiveLevel(-1);
    setScrub(null);
    setPreview(null);
    setMutedByAutoplay(false);

    // Autoplay chain: try sound-on first (works after a click anywhere on the
    // page, e.g. SPA navigation from the browse pages); if the browser's
    // autoplay policy blocks it (cold load, no gesture), start MUTED instead —
    // allowed everywhere — and surface the unmute pill. Before this, a blocked
    // play() was swallowed and the player sat paused/black forever.
    const startPlayback = async (el: HTMLVideoElement) => {
      try {
        await el.play();
        return;
      } catch { /* unmuted blocked — fall through */ }
      try {
        el.muted = true;
        await el.play();
        if (!cancelled) setMutedByAutoplay(true);
      } catch { /* hard-blocked — the big play button remains */ }
    };

    const setupHls = async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled || hls) return;

      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 5,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 1000,
          fragLoadingTimeOut: 45000,
          fragLoadingMaxRetry: 12,
          fragLoadingRetryDelay: 1500,
          // ---- buffering tuning ----
          // Longer forward buffer so network hiccups never reach the playhead;
          // capped by size so memory stays sane. capLevelToPlayerSize stops
          // 1080p bursts on small viewports; startLevel -1 + a bolder ABR
          // prior makes startup snappy and upgrades fast.
          maxBufferLength: 25,
          maxMaxBufferLength: 120,
          maxBufferSize: 80 * 1000 * 1000,
          backBufferLength: 30,
          capLevelToPlayerSize: true,
          startLevel: 0,
          startFragPrefetch: true,
          abrEwmaDefaultEstimate: 1_500_000,
          abrBandWidthUpFactor: 0.85,
        });
        hlsRef.current = hls;
        // All caption rendering goes through our own overlay; hls.js would
        // otherwise flip its embedded subtitle rendition (Japanese on these
        // streams) to "showing" underneath the bar — the "subs went down
        // again" regression. Instance property, not a config option.
        hls.subtitleDisplay = false;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled || !hls) return;
          const list = (hls.levels ?? [])
            .map((l, index): LevelInfo => ({
              index,
              label: l.height
                ? `${l.height}p`
                : `${Math.round((l.bitrate ?? 0) / 1000)}k`,
            }))
            .sort((a, b) => {
              const ha = parseInt(a.label) || 0;
              const hb = parseInt(b.label) || 0;
              return hb - ha;
            });
          setLevels(list);
          if (video.paused) void startPlayback(video);
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          if (cancelled) return;
          setActiveLevel(data.level);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !hls || !data.fatal) return;
          // Recoverable fatals get bounded in-place recovery instead of an
          // immediate failover — transient CDN blips and decoder hiccups
          // previously killed the source and hopped playback to another
          // server mid-episode.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 3) {
            networkRecoveries++;
            setBuffering(true);
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
            mediaRecoveries++;
            hls.recoverMediaError();
            return;
          }
          // Tear the loader down FIRST: a still-loading instance behind a
          // parent failover re-key keeps pulling segments into a dead player.
          hls.destroy();
          hls = null;
          hlsRef.current = null;
          console.warn("[hls.js] fatal after recovery:", data.type, data.details);
          onErrorRef.current?.();
        });

        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        console.error("HLS not supported");
        onErrorRef.current?.();
      }
    };

    if (isHls) void setupHls();
    else {
      video.src = src;
      void startPlayback(video);
    }

    const handleEnded = () => onEndedRef.current?.();

    const handleFirstPlay = () => {
      if (!firstPlayFired.current && onFirstPlayRef.current) {
        firstPlayFired.current = true;
        onFirstPlayRef.current();
      }
    };

    const handleError = () => {
      if (cancelled) return;
      if (reloadingRef.current) return;
      setShowError(true);
      setBuffering(false);
      onErrorRef.current?.();
    };

    video.addEventListener("ended", handleEnded);
    video.addEventListener("play", handleFirstPlay);
    video.addEventListener("error", handleError);

    // Exactly one visible caption track, even when registration lands late
    // (Chrome registers <track>-backed TextTracks asynchronously, and hls.js
    // can append its own subtitle renditions mid-stream). Late arrivals are
    // resolved by the dedicated addtrack-sync effect below.
    for (const sub of subtitlesRef.current ?? []) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = sub.label;
      track.srclang = sub.srclang || "en";
      track.src = sub.url;
      // No `track.default` here: Chrome applies it AFTER registration, which
      // can flip multiple tracks to "showing" behind the mode-sync effect
      // (user-reported: English + another language rendered at once). The
      // addtrack listener + applyCaptionModes below are the single authority.
      video.appendChild(track);
    }

    return () => {
      cancelled = true;
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("play", handleFirstPlay);
      video.removeEventListener("error", handleError);
      if (hls) {
        try { hls.destroy(); } catch { /* already destroyed */ }
        hls = null;
      }
      hlsRef.current = null;
      video.querySelectorAll("track").forEach((t) => t.remove());
      // Belt and braces: even if teardown races the media pipeline, silence
      // this element now — a detached <video> would otherwise keep playing
      // audio with no way to reach it.
      try { video.pause(); } catch { /* not attached */ }
      video.removeAttribute("src");
      try { video.load(); } catch { /* not attached */ }
    };
  }, [src, subtitlesKey]);

  /* ------- caption track state ------- */
  // The user's explicit caption choice (null = default, first track). All
  // DOM application happens in the sync effect below; this is state-only so
  // chip highlight, CC button and overlay stay derived and consistent.
  const setCaptionTrack = useCallback((idx: number) => {
    setCaptionChoice(idx);
  }, []);

  /* Authoritative caption application: the chosen track runs in `hidden` mode
     (cues still load + fire cuechange) while our own overlay renders the text
     ABOVE the control bar — native bottom-docked cues would sit under it.

     One effect owns everything so late arrivals replay correctly:
     - applies modes for the current choice,
     - (re)attaches the cuechange listener to the chosen track,
     - re-runs on every `addtrack` — Chrome registers <track>-backed
       TextTracks (and hls.js appends renditions) asynchronously, so tracks
       may surface AFTER this effect has already run. */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const has = (subtitles ?? []).length > 0;
    const idx = captionChoice ?? (has ? 0 : -1);
    // Compute the active cue text straight from the cue timings instead of
    // trusting `activeCues` alone: Chrome only recalculates the active set on
    // timeupdate ticks, so right after a seek the overlay could briefly show
    // the cue from before the scrub ("subs not matching the timeline").
    // Cheap and derived — identical results to cuechange via the same code.
    const computeActive = () => {
      const track = v.textTracks[idx];
      if (!has || idx < 0 || !track || track.mode !== "hidden") return;
      // Subtitle sync offset: these sources' VTT base and HLS timeline can be
      // shifted by a constant, so tune the cue lookup away from the media
      // clock. Positive ⇒ subtitles appear later.
      const t = v.currentTime - captionOffset;
      let text = "";
      if (track.cues) {
        for (let i = 0; i < track.cues.length; i++) {
          const c = track.cues[i] as VTTCue;
          if (t >= c.startTime && t < c.endTime) {
            text += (c.text ?? "").replace(/<[^>]*>?/gm, "") + "\n";
          }
        }
      }
      setCueText(text.replace(/\n{2,}/g, "\n").trim() || null);
    };
    const onCueChange = () => computeActive();
    let prev: TextTrack | null = null;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = i === idx && has ? "hidden" : "disabled";
      }
      const want = has && idx >= 0 ? v.textTracks[idx] ?? null : null;
      if (want !== prev) {
        if (prev) prev.removeEventListener("cuechange", onCueChange);
        prev = want;
        if (want) want.addEventListener("cuechange", onCueChange);
      }
    };
    apply();
    const onAddTrack = () => apply();
    v.addEventListener("addtrack", onAddTrack);
    // The sync pair: seeks and ordinary playback both re-derive the text.
    v.addEventListener("seeked", computeActive);
    v.addEventListener("timeupdate", computeActive);
    // While a seek is in flight the timings already point at the new spot,
    // so showing the old cue would look like the subs are out of sync.
    const onSeeking = () => setCueText(null);
    v.addEventListener("seeking", onSeeking);
    // Post-frame replay: on a fresh mount the <track> elements land in the
    // same commit but Chrome may register them in textTracks list after this.
    const raf = requestAnimationFrame(() => {
      apply();
      if (has && idx >= 0) computeActive();
      else setCueText(null);
    });
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("addtrack", onAddTrack);
      v.removeEventListener("seeked", computeActive);
      v.removeEventListener("timeupdate", computeActive);
      v.removeEventListener("seeking", onSeeking);
      if (prev) prev.removeEventListener("cuechange", onCueChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitlesKey, captionChoice, captionOffset]);

  /* ------- video element event wiring ------- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const pushTime = () => {
      if (!scrubRef.current) setCurrentTime(v.currentTime);
      // Throttled resume-position save (every 5s) so a refresh/crash mid-episode
      // still lets "Continue Watching" reopen at the right spot.
      const key = storageKeyRef.current;
      if (key) {
        const now = Date.now();
        if (now - lastSaveRef.current >= 5000) {
          lastSaveRef.current = now;
          saveResumePos(key, v.currentTime, v.duration);
        }
      }
    };
    const pushDur = () => {
      if (Number.isFinite(v.duration)) {
        setDuration(v.duration);
        durationRef.current = v.duration;
      }
    };
    const pushBuffered = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return;
      for (let i = v.buffered.length - 1; i >= 0; i--) {
        if (v.buffered.start(i) <= v.currentTime) {
          setBufferedEnd(v.buffered.end(i));
          return;
        }
      }
    };
    const onPlay = () => { setPlaying(true); };
    const onPause = () => {
      setPlaying(false);
      setControlsOn(true);
      const key = storageKeyRef.current;
      if (key) saveResumePos(key, v.currentTime, v.duration);
    };
    // Restore the saved position once per source, the first time metadata
    // becomes available. Reset on src change so each episode seeks to its own
    // saved spot.
    const onLoadedMetaRestore = () => {
      if (restoredRef.current) return;
      const key = storageKeyRef.current;
      if (!key || !resumePrefRef.current) { restoredRef.current = true; return; }
      const saved = getResumePos(key);
      // Don't resume inside the last 30s — the credits would roll immediately.
      const end = (v.duration || Infinity) - 30;
      if (saved > 10 && Number.isFinite(saved) && saved < end) {
        try { v.currentTime = saved; } catch { /* ignore */ }
      }
      restoredRef.current = true;
    };
    const onWaiting = () => {
      setBuffering(true);
      clearStallTimer();
      const v0 = videoRef.current;
      if (!v0) return;
      stallStartRef.current = { pos: v0.currentTime, attempts: 0 };
      const tryRecover = () => {
        const el = videoRef.current;
        if (!el) return;
        if (Math.abs(el.currentTime - stallStartRef.current.pos) >= 0.25) {
          // Recovered on its own.
          setBuffering(false);
          clearStallTimer();
          return;
        }
        stallStartRef.current.attempts++;
        if (stallStartRef.current.attempts === 1) {
          // One clean reconnect: reload the source and restore the position.
          // The proxy resumes dead upstream connections itself, so this is a
          // last resort for a connection that is dead end-to-end.
          const saved = el.currentTime;
          reloadingRef.current = true;
          el.src = srcRef.current || el.src;
          el.load();
          const onCanPlay = () => {
            el.removeEventListener("canplay", onCanPlay);
            reloadingRef.current = false;
            try { el.currentTime = saved; } catch { /* ignore */ }
            void el.play().catch(() => {});
          };
          el.addEventListener("canplay", onCanPlay);
          setTimeout(() => { reloadingRef.current = false; }, 10000);
          stallTimerRef.current = setTimeout(tryRecover, 8000);
        } else {
          // Still stuck — escalate to source failover so the watch page can
          // hop to another server or re-fetch the stream.
          clearStallTimer();
          setShowError(true);
          setBuffering(false);
          onErrorRef.current?.();
        }
      };
      stallTimerRef.current = setTimeout(tryRecover, 10000);
    };
    const onStalled = () => onWaiting();
    const onReady = () => { setBuffering(false); clearStallTimer(); };
    const onRate = () => setSpeed(v.playbackRate);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onPipEnter = () => setMenuOpen(false);

    v.addEventListener("timeupdate", pushTime);
    v.addEventListener("seeked", pushTime);
    v.addEventListener("loadedmetadata", onLoadedMetaRestore);
    v.addEventListener("durationchange", pushDur);
    v.addEventListener("loadedmetadata", pushDur);
    v.addEventListener("progress", pushBuffered);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onStalled);
    v.addEventListener("playing", onReady);
    v.addEventListener("canplay", onReady);
    v.addEventListener("seeked", onReady);
    v.addEventListener("ratechange", onRate);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("enterpictureinpicture", onPipEnter);

    // Post-frame so mount-time pushes are not synchronous setStates in the
    // effect body.
    const raf = requestAnimationFrame(() => {
      pushDur();
      pushBuffered();
    });

    return () => {
      cancelAnimationFrame(raf);
      clearStallTimer();
      v.removeEventListener("timeupdate", pushTime);
      v.removeEventListener("seeked", pushTime);
      v.removeEventListener("loadedmetadata", onLoadedMetaRestore);
      v.removeEventListener("durationchange", pushDur);
      v.removeEventListener("loadedmetadata", pushDur);
      v.removeEventListener("progress", pushBuffered);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onStalled);
      v.removeEventListener("playing", onReady);
      v.removeEventListener("canplay", onReady);
      v.removeEventListener("seeked", onReady);
      v.removeEventListener("ratechange", onRate);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("enterpictureinpicture", onPipEnter);
    };
  }, [clearStallTimer]);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const handleSurfaceClick = useCallback(() => {
    // With the settings panel open, the first tap on the video just closes it
    // instead of toggling play — matches YouTube/Mux behavior.
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    togglePlay();
  }, [menuOpen, togglePlay]);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    const d = durationRef.current || v.duration || 0;
    v.currentTime = Math.min(Math.max(0, t), d > 0 ? d - 0.05 : Number.MAX_SAFE_INTEGER);
    setCurrentTime(v.currentTime);
  }, []);

  const skip = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    seekTo(v.currentTime + delta);
  }, [seekTo]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      /* fullscreen denied / unsupported (mobile browsers) — ignore */
    }
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !pipAvailable) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { /* PiP rejected — ignore */ }
  }, [pipAvailable]);

  const pickLevel = useCallback((idx: number) => {
    setLevelPicked(idx);
    const hls = hlsRef.current;
    if (!hls) return;
    if (idx < 0) {
      hls.currentLevel = -1; // back to ABR
    } else {
      hls.currentLevel = idx;
    }
  }, []);

  const pickSpeed = useCallback((r: number) => {
    setSpeed(r);
    const v = videoRef.current;
    if (v) v.playbackRate = r;
  }, []);

  /* ------- control visibility (idle hide) ------- */
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    let timer: ReturnType<typeof setTimeout>;
    const poke = () => {
      setControlsOn(true);
      clearTimeout(timer);
      const v = videoRef.current;
      const stuck = v && !v.paused;
      if (stuck) {
        timer = setTimeout(() => {
          if (!menuOpenRef.current && !scrubRef.current) setControlsOn(false);
        }, 2600);
      }
    };
    c.addEventListener("pointermove", poke);
    c.addEventListener("pointerdown", poke);
    poke();
    return () => {
      clearTimeout(timer);
      c.removeEventListener("pointermove", poke);
      c.removeEventListener("pointerdown", poke);
    };
  }, [playing, menuOpen]);

  /* ------- global keyboard shortcuts ------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" || target.isContentEditable)
      ) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const v = videoRef.current;
      const key = e.key.toLowerCase();
      if (!v) return;

      switch (key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
          e.preventDefault();
          skip(-5);
          break;
        case "arrowright":
          e.preventDefault();
          skip(5);
          break;
        case "j":
          skip(-10);
          break;
        case "l":
          skip(10);
          break;
        case "arrowup":
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          v.muted = false;
          break;
        case "arrowdown":
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case "m": {
          v.muted = !v.muted;
          break;
        }
        case "f":
          void toggleFullscreen();
          break;
        case "escape": {
          if (menuOpenRef.current) setMenuOpen(false);
          break;
        }
        default:
          if (/^[0-9]$/.test(key)) {
            const d = durationRef.current;
            if (d > 0) seekTo((d * Number(key)) / 10);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, skip, seekTo, toggleFullscreen]);

  /* ------- progress bar scrubbing ------- */
  const onBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    scrubRef.current = true;
    setScrub(fracFromEvent(e, bar));
  }, []);

  const onBarPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    const f = fracFromEvent(e, bar);
    setPreview(f);
    if (scrubRef.current) setScrub(f);
    void e.stopPropagation();
  }, []);

  const onBarPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar) return;
    if (scrubRef.current) {
      const f = fracFromEvent(e, bar);
      seekTo(f * durationRef.current);
      setCurrentTime(f * durationRef.current);
      scrubRef.current = false;
      setScrub(null);
      bar.releasePointerCapture?.(e.pointerId);
    }
  }, [seekTo]);

  const onBarPointerLeave = useCallback(() => {
    setPreview(null);
  }, []);

  /* ------- skip intro / outro pills ------- */
  const introSkipped = useRef(false);
  const outroSkipped = useRef(false);
  useEffect(() => {
    introSkipped.current = false;
    outroSkipped.current = false;
  }, [src]);

  const applyAutoSkip = useCallback(() => {
    const v = videoRef.current;
    if (!v || !autoSkipRef.current) return;
    const t = v.currentTime;
    if (!introSkipped.current && skipIntroRef.current && t >= skipIntroRef.current.start && t < skipIntroRef.current.end - 0.5) {
      introSkipped.current = true;
      seekTo(skipIntroRef.current.end);
      return;
    }
    if (!outroSkipped.current && skipOutroRef.current && t >= skipOutroRef.current.start && t < skipOutroRef.current.end - 0.5) {
      outroSkipped.current = true;
      seekTo(skipOutroRef.current.end);
    }
  }, [seekTo]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => applyAutoSkip();
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [src, applyAutoSkip]);

  const showIntroPill =
    !!skipIntro && currentTime >= skipIntro.start + 0.5 && currentTime < skipIntro.end - 0.5;
  const showOutroPill =
    !!skipOutro && currentTime >= skipOutro.start + 0.5 && currentTime < skipOutro.end - 0.5;

  /* ------- derived ------- */
  const durationSafe = duration > 0 ? duration : 0;
  const progressFrac = scrub ?? (durationSafe > 0 ? currentTime / durationSafe : 0);
  const bufferedFrac = durationSafe > 0 ? Math.min(1, bufferedEnd / durationSafe) : 0;
  const previewTime = preview !== null ? preview * durationSafe : null;
  const volIcon = muted || volume === 0 ? Icon.muted : volume < 0.5 ? Icon.volLow : Icon.volHigh;
  const captionLabels = subtitles ?? [];
  const activeCaptionIdx = captionChoice ?? (captionLabels.length > 0 ? 0 : -1);

  const controlsVisible = controlsOn || !playing;

  /* ------- up-next card (last 8% of the episode) ------- */
  const nearEnd = durationSafe > 0 && currentTime / durationSafe >= 0.92;
  const showUpNext = !!onNext && nearEnd && !upNextDismissed;
  const autoNext = !!onEnded && autoAdvance;

  useEffect(() => {
    if (!showUpNext || !autoNext) return;
    let left = 10;
    const id = setInterval(() => {
      left -= 1;
      setNextCountdown(left);
      if (left <= 0) {
        clearInterval(id);
        onNextRef.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [showUpNext, autoNext]);

  /* ------------------------------ render ------------------------------ */
  return (
    <div
      ref={containerRef}
      // Intrinsic 16:9 — the player keeps a stable size before stream metadata
      // lands (the <video> element alone reports no intrinsic size). The
      // :fullscreen UA styles keep working since they override dimensions.
      className="relative aspect-video w-full overflow-hidden rounded-lg bg-black select-none [container-type:size] group/player"
      tabIndex={-1}
    >
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        preload="auto"
        onClick={handleSurfaceClick}
        onDoubleClick={() => void toggleFullscreen()}
      />

      {/* buffering spinner */}
      {buffering && !showError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-red-500" />
        </div>
      )}

      {/* big center play */}
      {!playing && !buffering && !showError && (
        <button
          aria-label="Play"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center transition-opacity"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-black/50 ring-2 ring-white/80 backdrop-blur-sm transition-transform hover:scale-105">
            {Icon.play}
          </span>
        </button>
      )}

      {/* error overlay */}
      {showError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-center">
          <p className="text-sm font-medium text-white">Playback error</p>
          <p className="text-xs text-white/60">Switching to another source…</p>
        </div>
      )}

      {/* mute-fallback notice: unmuted autoplay was blocked on cold load, so
          the stream started silently — one tap gives sound back */}
      {mutedByAutoplay && muted && (
        <button
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = false;
            setMutedByAutoplay(false);
          }}
          className="absolute top-3 right-3 z-30 flex items-center gap-2 rounded-full bg-black/70 px-3.5 py-2 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur-sm transition hover:bg-black/90"
          aria-label="Unmute video"
        >
          <VolumeX className="h-4 w-4" />
          Tap to unmute
        </button>
      )}

      {/* subtitle overlay: renders above the control bar (the chosen TextTrack
          runs in `hidden` mode, so the browser never draws its own cues) */}
      {cueText && activeCaptionIdx >= 0 && !showError && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[4.6rem] z-[5] flex justify-center px-4">
          <span className="max-w-[85%] whitespace-pre-line rounded bg-black/75 px-2.5 py-1 text-center leading-snug text-white text-[clamp(0.72rem,4.1cqh,2.6rem)]">
            {cueText}
          </span>
        </div>
      )}

      {/* skip intro / outro */}
      {(showIntroPill || showOutroPill) && !menuOpen && (
        <div className="absolute bottom-24 right-4 flex flex-col gap-2">
          {showIntroPill && (
            <button
              onClick={() => seekTo(skipIntro!.end)}
              className="rounded bg-white/90 px-4 py-2 text-sm font-bold text-black shadow-lg transition hover:bg-white"
            >
              Skip Intro
            </button>
          )}
          {showOutroPill && (
            <button
              onClick={() => seekTo(skipOutro!.end)}
              className="rounded bg-white/90 px-4 py-2 text-sm font-bold text-black shadow-lg transition hover:bg-white"
            >
              Skip Outro
            </button>
          )}
        </div>
      )}

      {/* settings panel */}
      {menuOpen && (
        <div className="absolute bottom-20 right-3 z-20 w-64 overflow-hidden rounded-lg border border-white/10 bg-zinc-900/95 text-sm text-white shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 font-semibold">
            <button onClick={() => setMenuOpen(false)} className="rounded p-1 hover:bg-white/10" aria-label="Close settings">
              {Icon.close}
            </button>
            <span>Settings</span>
          </div>
          <div ref={menuScrollRef} className="max-h-72 overflow-y-auto px-3 py-2 md:scrollbar-thin">
            <div className="mb-3">
              <p className="mb-1.5 text-xs uppercase tracking-wide text-white/50">Quality</p>
              <div className="flex flex-wrap gap-1.5">
                {levels.length > 0 ? (
                  <>
                    <button
                      onClick={() => pickLevel(-1)}
                      className={`rounded px-2.5 py-1 text-xs ${levelPicked === -1 ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                    >
                      Auto{levelPicked === -1 && activeLevel >= 0 && levels.find((l) => l.index === activeLevel)
                        ? ` (${levels.find((l) => l.index === activeLevel)!.label})`
                        : ""}
                    </button>
                    {levels.map((l) => (
                      <button
                        key={l.index}
                        onClick={() => pickLevel(l.index)}
                        className={`rounded px-2.5 py-1 text-xs ${levelPicked === l.index ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                      >
                        {l.label}
                      </button>
                    ))}
                  </>
                ) : (
                  /* Direct-file sources play at original quality — shown so
                     the option set stays consistent across all sources. */
                  <span className="rounded bg-white/5 px-2.5 py-1 text-xs text-white/40">Auto (Original)</span>
                )}
              </div>
            </div>

            <div className="mb-3">
              <p className="mb-1.5 text-xs uppercase tracking-wide text-white/50">Speed</p>
              <div className="flex flex-wrap gap-1.5">
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                  <button
                    key={r}
                    onClick={() => pickSpeed(r)}
                    className={`rounded px-2.5 py-1 text-xs ${speed === r ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                  >
                    {r === 1 ? "Normal" : `${r}x`}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-white/50">Subtitles</p>
              <div className="flex flex-wrap gap-1.5">
                {captionLabels.length > 0 ? (
                  <>
                    <button
                      onClick={() => setCaptionTrack(-1)}
                      className={`rounded px-2.5 py-1 text-xs ${activeCaptionIdx === -1 ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                    >
                      Off
                    </button>
                    {captionLabels.map((s, i) => (
                      <button
                        key={s.url || i}
                        onClick={() => setCaptionTrack(i)}
                        className={`rounded px-2.5 py-1 text-xs ${activeCaptionIdx === i ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="rounded bg-white/5 px-2.5 py-1 text-xs text-white/40">Not available on this server</span>
                    <p className="text-[11px] leading-snug text-white/35">Subtitles are served per-source — switch to a server like Megaplay for tracks.</p>
                  </div>
                )}
                {captionLabels.length > 0 && activeCaptionIdx >= 0 && (
                  <div className="mt-2">
                    <p className="mb-1.5 text-xs uppercase tracking-wide text-white/50">Sync</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {[-1, -0.5, -0.25, 0, 0.25, 0.5, 1].map((o) => (
                        <button
                          key={o}
                          onClick={() => setCaptionOffset(o)}
                          className={`rounded px-2 py-1 text-xs ${captionOffset === o ? "bg-red-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                          title={o > 0 ? `Delay subtitle by ${o}s` : o < 0 ? `Advance subtitle by ${Math.abs(o)}s` : "No offset"}
                        >
                          {o === 0 ? "Default" : `${o > 0 ? "+" : ""}${o}s`}
                        </button>
                      ))}
                      <span className="text-xs text-white/50">{captionOffset === 0 ? "in sync" : captionOffset > 0 ? "subs delayed" : "subs advanced"}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* up-next card — appears for the last 8%, never covers the controls */}
      {showUpNext && (
        <div className="absolute bottom-[92px] right-3 z-30 w-[260px] animate-fade-in-up rounded-surface border border-white/15 bg-black/80 p-3 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <p className="text-2xs font-semibold uppercase tracking-wider text-white/55">
              {autoNext ? "Up next" : "Next episode"}
            </p>
            <button
              onClick={() => setUpNextDismissed(true)}
              aria-label="Dismiss up-next card"
              className="rounded p-0.5 text-white/50 transition-colors hover:text-white"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-white">
            {nextTitle || nextLabel || "Next episode"}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => onNextRef.current?.()}
              className="inline-flex items-center gap-1.5 rounded-control bg-white px-2.5 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-white/85"
            >
              <Play className="h-3 w-3 fill-black" aria-hidden />
              Play now
            </button>
            {autoNext && (
              <span className="text-2xs tabular-nums text-white/55">
                in {nextCountdown ?? 10}s
              </span>
            )}
          </div>
        </div>
      )}

      {/* control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200 ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* progress bar */}
        <div
          ref={barRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.floor(durationSafe)}
          aria-valuenow={Math.floor(progressFrac * durationSafe)}
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          onPointerLeave={onBarPointerLeave}
          className="group/bar relative -mx-1 flex h-5 cursor-pointer items-center px-1 touch-none"
        >
          <div className="relative h-1 w-full rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
            {/* buffered */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${bufferedFrac * 100}%` }}
            />
            {/* played */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-red-500"
              style={{ width: `${progressFrac * 100}%` }}
            >
              {/* scrubber knob */}
              <span
                className={`absolute -right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-red-500 shadow transition-transform ${
                  scrub !== null ? "scale-125" : "scale-0 group-hover/bar:scale-100"
                }`}
              />
            </div>
            {/* skip-interval markers (intro / outro) */}
            {durationSafe > 0 && (
              <>
                {skipIntro && skipIntro.start >= 0 && skipIntro.end > skipIntro.start && (
                  <div
                    className="absolute inset-y-0 rounded-full bg-amber-400/45 ring-1 ring-amber-400/70 pointer-events-none"
                    style={{
                      left: `${(skipIntro.start / durationSafe) * 100}%`,
                      width: `${((skipIntro.end - skipIntro.start) / durationSafe) * 100}%`,
                    }}
                    title={`Intro: ${fmtTime(skipIntro.start)}–${fmtTime(skipIntro.end)}`}
                  />
                )}
                {skipOutro && skipOutro.start >= 0 && skipOutro.end > skipOutro.start && (
                  <div
                    className="absolute inset-y-0 rounded-full bg-violet-400/45 ring-1 ring-violet-400/70 pointer-events-none"
                    style={{
                      left: `${(skipOutro.start / durationSafe) * 100}%`,
                      width: `${((skipOutro.end - skipOutro.start) / durationSafe) * 100}%`,
                    }}
                    title={`Outro: ${fmtTime(skipOutro.start)}–${fmtTime(skipOutro.end)}`}
                  />
                )}
              </>
            )}
          </div>

          {/* hover/drag time tooltip */}
          {previewTime !== null && (
            <div
              className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded bg-black/90 px-2 py-0.5 text-xs font-medium text-white"
              style={{ left: `${(preview ?? 0) * 100}%`, whiteSpace: "nowrap" }}
            >
              {fmtTime(previewTime)}
            </div>
          )}
        </div>

        {/* buttons row */}
        <div className="mt-1 flex items-center gap-1.5 text-white">
          <button onClick={togglePlay} className="rounded p-1.5 transition hover:bg-white/10" aria-label={playing ? "Pause" : "Play"}>
            {playing ? Icon.pause : Icon.play}
          </button>
          <button onClick={() => skip(-10)} className="rounded p-1.5 transition hover:bg-white/10" aria-label="Back 10 seconds">
            {Icon.skipBack}
          </button>
          <button onClick={() => skip(10)} className="rounded p-1.5 transition hover:bg-white/10" aria-label="Forward 10 seconds">
            {Icon.skipFwd}
          </button>

          {/* volume */}
          <div className="group/vol flex items-center">
            <button
              onClick={() => {
                const v = videoRef.current;
                if (v) v.muted = !v.muted;
                setMutedByAutoplay(false);
              }}
              className="rounded p-1.5 transition hover:bg-white/10"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {volIcon}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = videoRef.current;
                if (!v) return;
                v.volume = Number(e.target.value);
                v.muted = Number(e.target.value) === 0;
              }}
              className="h-1 w-0 cursor-pointer accent-red-500 opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 group-hover/vol:mr-2"
              aria-label="Volume"
            />
          </div>

          <span className="ml-1.5 whitespace-nowrap font-mono text-[13px] tabular-nums text-white/90">
            {fmtTime(scrub !== null ? scrub * durationSafe : currentTime)} <span className="text-white/50">/ {fmtTime(durationSafe)}</span>
          </span>

          <div className="flex-1" />

          <button
            onClick={() => setCaptionTrack(activeCaptionIdx >= 0 ? -1 : 0)}
            disabled={captionLabels.length === 0}
            className={`rounded p-1.5 transition disabled:cursor-not-allowed disabled:text-white/30 ${captionLabels.length === 0 ? "" : activeCaptionIdx >= 0 ? "text-red-500 hover:bg-white/10" : "hover:bg-white/10"}`}
            aria-label="Toggle subtitles"
          >
            {Icon.cc}
          </button>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className={`rounded p-1.5 transition hover:bg-white/10 ${menuOpen ? "text-red-500" : ""}`}
            aria-label="Settings"
          >
            {Icon.gear}
          </button>
          {pipAvailable && (
            <button onClick={() => void togglePip()} className="rounded p-1.5 transition hover:bg-white/10" aria-label="Picture in picture">
              {Icon.pip}
            </button>
          )}
          <button onClick={() => void toggleFullscreen()} className="rounded p-1.5 transition hover:bg-white/10" aria-label="Fullscreen">
            {isFullscreen ? Icon.fsExit : Icon.fs}
          </button>
        </div>
      </div>
    </div>
  );
}
