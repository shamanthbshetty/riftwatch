"use client";

import EpisodeNotifier from "./EpisodeNotifier";
import EpisodeNotifierMovies from "./EpisodeNotifierMovies";

// Always mounted — each notifier pauses its polling on /watch/ itself. The old
// approach returned null on watch pages, unmounting/remounting the pollers on
// every navigation (lost in-flight sweeps, new state each time).
export default function Notifiers() {
  return (
    <>
      <EpisodeNotifier />
      <EpisodeNotifierMovies />
    </>
  );
}
