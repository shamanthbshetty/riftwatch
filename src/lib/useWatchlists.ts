"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  subscribeStore,
  refreshStore,
  getWatchlistSnapshot,
  getMovieWatchlistSnapshot,
  getContinueWatchingSnapshot,
  getContinueWatchingMoviesSnapshot,
  getAllHistorySnapshot,
  getNotificationsSnapshot,
  getMovieNotificationsSnapshot,
  getThemeSnapshot,
  getResumeForShowSnapshot,
  getResumeForMovieSnapshot,
  getMovieSeasonWatchedSnapshot,
  getWatchedUpToSnapshot,
  getMovieWatchedUpToSnapshot,
  getAutoplaySnapshot,
  getSkipSnapshot,
  getResumePrefSnapshot,
  setTheme as persistTheme,
  type WatchlistItem,
  type MovieWatchlistItem,
  type HistoryItem,
  type MovieHistoryItem,
  type AppNotification,
  type ShowResume,
  type MovieResume,
} from "./storage";

// Stable server snapshot — useSyncExternalStore requires an identical reference
// on every call, and localStorage is unavailable during SSR.
const EMPTY: never[] = [];

// Keep sibling tabs in sync when one of them edits the store. One shared,
// ref-counted listener regardless of how many hooks are mounted (previously
// every hook added its own copy, so a storage event ran refreshStore N times).
let crossTabRefs = 0;
function onStorage(e: StorageEvent) {
  // key === null means the whole store was cleared (localStorage.clear()).
  if (e.key === null) {
    refreshStore();
    return;
  }
  if (e.key === "theme") {
    // setTheme only sets data-theme in the tab that toggled — re-apply it
    // here or this tab keeps rendering the old palette.
    const t = e.newValue === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    refreshStore();
    return;
  }
  refreshStore();
}
function useCrossTabSync() {
  useEffect(() => {
    if (crossTabRefs++ === 0) window.addEventListener("storage", onStorage);
    return () => {
      if (--crossTabRefs === 0) window.removeEventListener("storage", onStorage);
    };
  }, []);
}

/** Ids on the anime watchlist, kept in sync across every mounted component. */
export function useWatchlistIds(): Set<string> {
  const list = useSyncExternalStore(subscribeStore, getWatchlistSnapshot, () => EMPTY);
  useCrossTabSync();
  return useMemo(() => new Set(list.map((i: WatchlistItem) => i.id)), [list]);
}

export function useIsInWatchlist(id: string): boolean {
  return useWatchlistIds().has(id);
}

/** Full anime watchlist entries, kept in sync. */
export function useWatchlistItems(): WatchlistItem[] {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getWatchlistSnapshot, () => EMPTY);
}

/** Full movie/TV watchlist entries, kept in sync. */
export function useMovieWatchlistItems(): MovieWatchlistItem[] {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getMovieWatchlistSnapshot, () => EMPTY);
}

/** True when the movie/TV id is on the movie watchlist, kept in sync. */
export function useIsInMovieWatchlist(id: string): boolean {
  const list = useMovieWatchlistItems();
  return useMemo(() => list.some((i: MovieWatchlistItem) => i.id === id), [list, id]);
}

/** In-progress anime (most recent episode per show), kept in sync. */
export function useContinueWatching(): HistoryItem[] {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getContinueWatchingSnapshot, () => EMPTY);
}

/** In-progress movies/TV, kept in sync. */
export function useContinueWatchingMovies(): MovieHistoryItem[] {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getContinueWatchingMoviesSnapshot, () => EMPTY);
}

/** Full watch history, kept in sync. */
export function useAllHistory(): HistoryItem[] {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getAllHistorySnapshot, () => EMPTY);
}

/** Newest saved playback position for one show ("Continue …" on the detail page). */
export function useShowResume(id: string): ShowResume | null {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, () => getResumeForShowSnapshot(id), () => null);
}

/** Saved playback position for one movie/TV id. */
export function useMovieResume(id: string): MovieResume | null {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, () => getResumeForMovieSnapshot(id), () => null);
}

/** Episodes of one TV season already watched (detail-page progress chips). */
export function useMovieSeasonWatched(id: string, season: number): number {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, () => getMovieSeasonWatchedSnapshot(id, season), () => 0);
}

/** High-water mark for the red watched tiles (reactive + SSR-safe). */
export function useWatchedUpTo(id: string, mode: "sub" | "dub"): number {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, () => getWatchedUpToSnapshot(id, mode), () => 0);
}

/** Latest-viewed season/episode of a TV show (red tiles on the watch page). */
export function useMovieWatchedUpTo(id: string): { season?: number; episode?: number } | null {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, () => getMovieWatchedUpToSnapshot(id), () => null);
}

/** Persisted autoplay preference — read via the external store so the SSR
    markup and the first client render agree (server snapshot: ON). */
export function useAutoplayPref(): boolean {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getAutoplaySnapshot, () => true);
}

/** Persisted auto OP/ED skip preference (server snapshot: ON). */
export function useSkipPref(): boolean {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getSkipSnapshot, () => true);
}

/** Persisted "resume where I left off" preference (server snapshot: ON). */
export function useResumePref(): boolean {
  useCrossTabSync();
  return useSyncExternalStore(subscribeStore, getResumePrefSnapshot, () => true);
}

const EMPTY_NOTIFICATIONS: AppNotification[] = [];

/** In-app notifications for the active tab, kept in sync. */
export function useNotifications(isMovies: boolean) {
  useCrossTabSync();
  const list = useSyncExternalStore(
    subscribeStore,
    isMovies ? getMovieNotificationsSnapshot : getNotificationsSnapshot,
    () => EMPTY_NOTIFICATIONS
  );
  const unread = useMemo(() => list.filter((n) => !n.read).length, [list]);
  return { notifs: list, unread };
}

const DARK: "dark" | "light" = "dark";

/** Persisted colour theme. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribeStore, getThemeSnapshot, () => DARK);
  const toggle = useCallback(() => persistTheme(theme === "dark" ? "light" : "dark"), [theme]);
  return { theme, toggleTheme: toggle };
}
