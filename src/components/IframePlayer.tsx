"use client";

import { useEffect, useRef } from "react";

interface IframePlayerProps {
  src: string;
  onError: () => void;
  onEnded?: () => void;
  /** Fired when the embed document loads — best available "playback started"
      signal for cross-origin players (they usually autoplay). */
  onLoad?: () => void;
}

// Cross-origin iframes can't report load failures, so a player that never fires
// load within this window is treated as dead and the caller fails over.
const LOAD_TIMEOUT_MS = 20_000;

export default function IframePlayer({ src, onError, onEnded, onLoad }: IframePlayerProps) {
  const loadedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Timeout follows src only: callers pass an inline onError whose identity
  // changes per render, which used to restart the 20s timer on every render
  // (a slow embed could then never be failed over).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    loadedRef.current = false;
    const t = setTimeout(() => {
      if (!loadedRef.current) onErrorRef.current?.();
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [src]);

  useEffect(() => {
    if (!onEnded) return;
    const handler = (e: MessageEvent) => {
      if (e.data !== "video-ended") return;
      // e.source is authoritative: only the embedded document can post with its
      // own window as source. Without this check ANY origin can force the
      // player to navigate to the next episode.
      if (e.source !== iframeRef.current?.contentWindow) return;
      onEnded();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onEnded]);

  return (
    <div className="player-wrap relative group w-full bg-black rounded-lg" style={{ aspectRatio: "16/9" }}>
      {/* Never sandbox: every player family we embed (megaplay/Anikoto, the
          VidSrc network incl. 2Embed's inner player) probes sandboxing and
          refuses — either via document.domain (throws in sandboxed frames)
          or a "Forbidden" response from sandbox.php. Verified in-browser:
          sandboxed → refusal; unsandboxed → plays. */}
      {/* scrolling="no" + overflow-hidden: upstream embed pages (1anime.site/
          megaplay, VidSrc) render 4px taller than their viewport, which puts a
          scrollbar INSIDE the video frame. Cross-origin, so the inner document
          can't be styled — suppressing the frame's scrolling is the only lever. */}
      {/* allowFullScreen (legacy attr): allow="fullscreen" covers modern
          Chromium, but Safari/WebKit still keys off the boolean attribute. */}
      <iframe
        ref={iframeRef}
        src={src}
        onLoad={() => { loadedRef.current = true; onLoad?.(); }}
        className="w-full h-full border-0 overflow-hidden"
        scrolling="no"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
