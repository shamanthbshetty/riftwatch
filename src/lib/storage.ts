import { posterUrl } from "./movies";

// History rows have been written with both raw TMDB paths and full URLs.
function normalizePoster(poster: string): string {
  if (!poster) return "";
  if (poster.startsWith("http://") || poster.startsWith("https://")) return poster;
  return posterUrl(poster) ?? "";
}

// Watchlist status. Optional on stored items — entries saved before this
// existed read as "watching", so no migration step is needed.
export type WatchStatus = "watching" | "completed" | "on-hold" | "planned";

export interface WatchlistItem {
  id: string;
  title: string;
  englishName?: string;
  thumbnail: string;
  malId: string;
  lastEp: number;
  mode: "sub" | "dub";
  status?: WatchStatus;
  timestamp: number;
}

export interface HistoryItem {
  id: string;
  title: string;
  englishName?: string;
  thumbnail: string;
  malId: string;
  ep: number;
  mode: "sub" | "dub";
  timestamp: number;
}

export interface MovieWatchlistItem {
  id: string;
  title: string;
  poster: string;
  type: "movie" | "tv";
  status?: WatchStatus;
  timestamp: number;
}

export interface MovieHistoryItem {
  id: string;
  title: string;
  poster: string;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
  timestamp: number;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  thumbnail: string;
  href: string;
  hrefSub?: string;
  hrefDub?: string;
  subCount?: number;
  dubCount?: number;
  releasedAt?: string;
  episodeLabel?: string;
  read: boolean;
  timestamp: number;
}

function get<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function set(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota exceeded */ }
}

// Per-show metadata/title caches can get large (one show with 1000+ episode
// names is ~100 KB). Keep a bounded, most-recently-used set so a heavy user
// can't fill the webview's localStorage quota over time.
const CACHE_INDEX_KEY = "rw:cache-index";
const SHOW_CACHE_LIMIT = 25;

function pruneShowCaches(): void {
  if (typeof window === "undefined") return;
  try {
    let index: Record<string, number> = {};
    try { index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || "{}") || {}; } catch { /* ignore */ }
    const ids = Object.keys(index).sort((a, b) => index[b] - index[a]);
    let changed = false;
    for (const id of ids.slice(SHOW_CACHE_LIMIT)) {
      localStorage.removeItem(`rw:show:${id}`);
      localStorage.removeItem(`rw:titles:${id}`);
      delete index[id];
      changed = true;
    }
    if (changed) localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch { /* quota exceeded */ }
}

/** Write a show-info cache entry, evicting the least recently used shows. */
export function setShowCache(id: string, info: unknown): void {
  try {
    let index: Record<string, number> = {};
    try { index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || "{}") || {}; } catch { /* ignore */ }
    index[id] = Date.now();
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch { /* ignore */ }
  pruneShowCaches();
  try { localStorage.setItem(`rw:show:${id}`, JSON.stringify(info)); } catch { /* quota exceeded */ }
}

/** Write an episode-title cache entry, evicting the least recently used shows. */
export function setTitlesCache(id: string, titles: Record<string, string>): void {
  try {
    let index: Record<string, number> = {};
    try { index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || "{}") || {}; } catch { /* ignore */ }
    index[id] = Date.now();
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch { /* ignore */ }
  pruneShowCaches();
  try { localStorage.setItem(`rw:titles:${id}`, JSON.stringify(titles)); } catch { /* quota exceeded */ }
}

// Clean up caches written by older versions on first load.
if (typeof window !== "undefined") pruneShowCaches();

// ponytail: external-store plumbing. Components read localStorage through
// useSyncExternalStore (see useWatchlists.ts) so a write in one place re-renders
// every other mounted view instead of leaving them stale until their own reload.
type StoreListener = () => void;
const storeListeners = new Set<StoreListener>();
const snapshotCache = new Map<string, unknown>();

function cachedSnapshot<T>(key: string, compute: () => T): T {
  if (!snapshotCache.has(key)) snapshotCache.set(key, compute());
  return snapshotCache.get(key) as T;
}

export function subscribeStore(listener: StoreListener): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/** Drop cached snapshots for `keys` and notify subscribers. */
function invalidate(...keys: string[]) {
  for (const key of keys) snapshotCache.delete(key);
  for (const listener of storeListeners) listener();
}

/** Drop every cached snapshot whose key starts with `prefix` (no notify). */
function invalidatePrefix(prefix: string) {
  for (const key of [...snapshotCache.keys()]) {
    if (key.startsWith(prefix)) snapshotCache.delete(key);
  }
}

// ponytail: autoplay preference (shared by anime + movie watch pages).
// Plain localStorage, read once per page mount — no subscription needed.
const AUTOPLAY_KEY = "autoplay";

export function getAutoplayPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(AUTOPLAY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoplayPref(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTOPLAY_KEY, on ? "1" : "0");
  } catch { /* quota exceeded */ }
  invalidate("autoplay");
}

export const getAutoplaySnapshot = (): boolean => cachedSnapshot("autoplay", getAutoplayPref);

// ponytail: auto OP/ED skip preference (anime watch page).
// Default ON — auto-skip only ever jumps within intervals the AniSkip
// crowd-sourced data reports, and users overwhelmingly expect it.
const SKIP_KEY = "autoskip";

export function getSkipPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(SKIP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSkipPref(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SKIP_KEY, on ? "1" : "0");
  } catch { /* quota exceeded */ }
  invalidate("autoskip");
}

export const getSkipSnapshot = (): boolean => cachedSnapshot("autoskip", getSkipPref);

// Resume-where-you-left-off preference. Default ON — the saved position is
// only ever applied when it is more than a few seconds in.
const RESUME_PREF_KEY = "resume-playback";

export function getResumePref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(RESUME_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setResumePref(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(RESUME_PREF_KEY, on ? "1" : "0");
  } catch { /* quota exceeded */ }
  invalidate("resume-pref");
}

export const getResumePrefSnapshot = (): boolean => cachedSnapshot("resume-pref", getResumePref);

/**
 * Raw JSON signature of every key refreshStore() re-reads. Cheap (no JSON.parse)
 * — lets the periodic poller skip notifying all subscribers when nothing changed.
 */
export function storeSignature(): string {
  if (typeof window === "undefined") return "";
  try {
    return [
      "watchlist", "movie-watchlist", "history", "movie-history",
      "notifications", "movie-notifications", "resume-pos", "theme",
      "ep-cache", "tv-ep-cache",
    ].map((k) => `${k}=${localStorage.getItem(k) ?? ""}`).join("|");
  } catch {
    return "";
  }
}

/** Re-read localStorage after an out-of-band write (e.g. another browser tab). */
export function refreshStore() {
  invalidatePrefix("resume:");
  invalidatePrefix("movie-watched:");
  invalidatePrefix("watched:");
  invalidate(
    "watchlist",
    "movie-watchlist",
    "history",
    "anime-continue",
    "movie-continue",
    "movie-history",
    "notifications",
    "movie-notifications",
    "theme"
  );
}

// ponytail: anime watchlist & history
export function getWatchlist(): WatchlistItem[] {
  return get<WatchlistItem[]>("watchlist") ?? [];
}

export const getWatchlistSnapshot = (): WatchlistItem[] => cachedSnapshot("watchlist", getWatchlist);

export function addToWatchlist(item: Omit<WatchlistItem, "timestamp">) {
  const list = getWatchlist().filter((i) => i.id !== item.id);
  list.unshift({ ...item, timestamp: Date.now() });
  set("watchlist", list);
  invalidate("watchlist");
}

export function removeFromWatchlist(id: string) {
  set("watchlist", getWatchlist().filter((i) => i.id !== id));
  const cache = getEpCache();
  delete cache[id];
  set("ep-cache", cache);
  invalidate("watchlist");
}

export function setWatchlistStatus(id: string, status: WatchStatus) {
  const list = getWatchlist();
  const item = list.find((i) => i.id === id);
  if (!item || item.status === status) return;
  item.status = status;
  set("watchlist", list);
  invalidate("watchlist");
}

export function addToHistory(item: Omit<HistoryItem, "timestamp">) {
  // A malformed `ep` from the URL (ep=abc → Number → NaN) would poison the
  // list: dedupe/compare logic downstream silently never matches NaN.
  if (!Number.isFinite(item.ep)) return;

  // One show can arrive under several ids (AllAnime hash, AniList/MAL numeric,
  // kitsu-…). Drop an existing row for the same episode under ANY alias, not
  // just the exact id, or a revisit creates a second copy of the show.
  const row: HistoryItem = { ...item, timestamp: Date.now() };
  const hist = getHistory().filter((i) => !(i.ep === row.ep && sameHistoryShow(i, row)));
  hist.unshift(row);
  if (hist.length > 100) hist.length = 100;
  set("history", hist);
  invalidate("history", "anime-continue");
  invalidatePrefix("watched:");
}

export function removeFromHistory(id: string, ep: number) {
  const hist = getHistory();
  const group = historyGroups(hist).find((rows) => rows.some((h) => h.id === id));
  if (!group) return;
  const doomed = new Set(group);
  set("history", hist.filter((h) => !(h.ep === ep && doomed.has(h))));
  invalidate("history", "anime-continue");
  invalidatePrefix("watched:");
}

/** Remove EVERY episode row of one show (history page rows are per-show). */
export function removeShowFromHistory(id: string) {
  const hist = getHistory();
  const group = historyGroups(hist).find((rows) => rows.some((h) => h.id === id));
  if (!group) return;
  const doomed = new Set(group);
  set("history", hist.filter((h) => !doomed.has(h)));
  invalidate("history", "anime-continue");
  invalidatePrefix("watched:");
}

function getHistory(): HistoryItem[] {
  return get<HistoryItem[]>("history") ?? [];
}

function validMalId(h: Pick<HistoryItem, "malId">): string {
  const malId = (h.malId || "").trim();
  return malId && malId !== "0" ? malId : "";
}

function normalizeText(value?: string): string {
  return (value || "").normalize("NFKC").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();
}

function titleKeys(h: HistoryItem): string[] {
  const keys = [normalizeText(h.title), normalizeText(h.englishName)].filter(Boolean);
  return [...new Set(keys)];
}

function posterKey(url?: string): string {
  const clean = (url || "").split("?")[0];
  return clean.slice(clean.lastIndexOf("/") + 1).trim();
}

function sameHistoryShow(a: HistoryItem, b: HistoryItem): boolean {
  if (a.id && a.id === b.id) return true;
  const am = validMalId(a);
  const bm = validMalId(b);
  if (am && bm && am === bm) return true;
  const ta = titleKeys(a);
  const tb = titleKeys(b);
  if (!ta.some((t) => tb.includes(t))) return false;
  const ap = posterKey(a.thumbnail);
  const bp = posterKey(b.thumbnail);
  if (!ap || !bp || ap === bp) return true;
  return !(am && bm && am !== bm);
}

function historyGroups(hist: HistoryItem[]): HistoryItem[][] {
  const parent = hist.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < hist.length; i++) {
    for (let j = i + 1; j < hist.length; j++) {
      if (!sameHistoryShow(hist[i], hist[j])) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[rj] = ri;
    }
  }
  const groups = new Map<number, HistoryItem[]>();
  hist.forEach((item, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  });
  return [...groups.values()];
}

/** AniList/MAL ids are numeric; AllAnime hashes and `kitsu-…` are canonical. */
function isCanonicalAnimeId(id: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(id) || id.startsWith("kitsu-");
}

/**
 * One row per show, newest first. Rows written before ids were canonicalised
 * (same show stored under a numeric id AND its AllAnime hash) collapse here,
 * and the surviving row points at the canonical id so resume keys still match.
 */
function dedupeHistory(hist: HistoryItem[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const rows of historyGroups(hist)) {
    let newest = rows[0];
    for (const r of rows) {
      if ((r.timestamp ?? 0) > (newest.timestamp ?? 0)) newest = r;
    }
    const canonical = isCanonicalAnimeId(newest.id)
      ? newest.id
      : rows.map((r) => r.id).find(isCanonicalAnimeId);
    out.push(canonical && canonical !== newest.id ? { ...newest, id: canonical } : newest);
  }
  return out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function getAllHistory(): HistoryItem[] {
  return dedupeHistory(getHistory());
}

export function getContinueWatching(): HistoryItem[] {
  return dedupeHistory(getHistory()).slice(0, 12);
}

export const getContinueWatchingSnapshot = (): HistoryItem[] =>
  cachedSnapshot("anime-continue", getContinueWatching);

export const getAllHistorySnapshot = (): HistoryItem[] => cachedSnapshot("history", getAllHistory);

function findShowGroup(hist: HistoryItem[], showId: string): HistoryItem[] | null {
  return historyGroups(hist).find((rows) => rows.some((h) => h.id === showId || validMalId(h) === showId)) ?? null;
}

export function getLastWatched(showId: string): HistoryItem | null {
  const group = findShowGroup(getHistory(), showId);
  if (!group) return null;
  return group.reduce((latest, h) => ((h.timestamp ?? 0) > (latest.timestamp ?? 0) ? h : latest));
}

export function getWatchedUpTo(showId: string, mode: "sub" | "dub"): number {
  const group = findShowGroup(getHistory(), showId);
  if (!group) return 0;
  const rows = group.filter((h) => h.mode === mode);
  if (rows.length === 0) return 0;
  return rows.reduce((latest, h) => ((h.timestamp ?? 0) > (latest.timestamp ?? 0) ? h : latest)).ep;
}

export const getWatchedUpToSnapshot = (showId: string, mode: "sub" | "dub"): number =>
  cachedSnapshot(`watched:${showId}:${mode}`, () => getWatchedUpTo(showId, mode));

// ponytail: playback-position resume (per episode/movie key → seconds)
interface ResumeEntry {
  t: number;
  at: number;
  /** Media duration in seconds, when the player knew it. Enables a real progress bar. */
  d?: number;
}
type ResumeMap = Record<string, ResumeEntry>;

const RESUME_KEY = "resume-pos";
const RESUME_MAX_ENTRIES = 300;
const RESUME_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

function getResumeMap(): ResumeMap {
  return get<ResumeMap>(RESUME_KEY) ?? {};
}

/** Saved playback position in seconds (0 when none/unknown). */
export function getResumePos(key: string): number {
  return getResumeMap()[key]?.t ?? 0;
}

export function saveResumePos(key: string, time: number, duration?: number) {
  if (!Number.isFinite(time) || time < 5) return;
  const map = getResumeMap();
  map[key] = {
    t: time,
    at: Date.now(),
    ...(Number.isFinite(duration) && (duration ?? 0) > 0 ? { d: duration } : {}),
  };
  // Prune: drop stale entries, then cap the map so it can't grow unbounded.
  const now = Date.now();
  let entries = Object.entries(map).filter(([, e]) => now - e.at < RESUME_MAX_AGE);
  if (entries.length > RESUME_MAX_ENTRIES) {
    entries.sort((a, b) => b[1].at - a[1].at);
    entries = entries.slice(0, RESUME_MAX_ENTRIES);
  }
  set(RESUME_KEY, Object.fromEntries(entries));
  invalidatePrefix("resume:");
  invalidate();
}

export function clearResumePos(key: string) {
  const map = getResumeMap();
  if (!(key in map)) return;
  delete map[key];
  set(RESUME_KEY, map);
  invalidatePrefix("resume:");
  invalidate();
}

// ── Resume lookup for detail pages ("Continue from where you left off") ──

export interface ShowResume {
  ep: number;
  mode: "sub" | "dub";
  t: number;
  /** Duration of that episode in seconds, when known. */
  d?: number;
}

export interface MovieResume {
  type: "movie" | "tv";
  season?: number;
  episode?: number;
  t: number;
  /** Duration in seconds, when known. */
  d?: number;
}

/** Newest saved playback position across any episode of the show. */
export function getResumeForShow(showId: string): ShowResume | null {
  const prefix = `anime|${showId}|`;
  let best: ShowResume | null = null;
  let bestAt = -1;
  for (const [k, e] of Object.entries(getResumeMap())) {
    if (!k.startsWith(prefix)) continue;
    const parts = k.split("|");
    const mode = parts[2];
    const ep = Number(parts[3]);
    if ((mode !== "sub" && mode !== "dub") || !Number.isInteger(ep) || ep < 1) continue;
    if (e.at > bestAt) {
      bestAt = e.at;
      best = { ep, mode, t: e.t, ...(e.d ? { d: e.d } : {}) };
    }
  }
  return best;
}

export const getResumeForShowSnapshot = (showId: string): ShowResume | null =>
  cachedSnapshot(`resume:show:${showId}`, () => getResumeForShow(showId));

/** Saved playback position for a movie (or a TV episode, with season/episode). */
export function getResumeForMovie(id: string): MovieResume | null {
  const prefix = `movie|${id}|`;
  let best: MovieResume | null = null;
  let bestAt = -1;
  for (const [k, e] of Object.entries(getResumeMap())) {
    if (!k.startsWith(prefix)) continue;
    const parts = k.split("|");
    let entry: MovieResume | null = null;
    if (parts[2] === "movie") {
      entry = { type: "movie", t: e.t, ...(e.d ? { d: e.d } : {}) };
    } else if (parts[2] === "tv") {
      const season = Number(parts[3]);
      const episode = Number(parts[4]);
      if (Number.isInteger(season) && Number.isInteger(episode)) {
        entry = { type: "tv", season, episode, t: e.t, ...(e.d ? { d: e.d } : {}) };
      }
    }
    if (entry && e.at > bestAt) {
      bestAt = e.at;
      best = entry;
    }
  }
  return best;
}

export const getResumeForMovieSnapshot = (id: string): MovieResume | null =>
  cachedSnapshot(`resume:movie:${id}`, () => getResumeForMovie(id));

/** "12:34" or "1:02:03" for resume labels. */
export function formatMediaTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function getEpCache(): Record<string, number | { sub: number; dub: number }> {
  return (get("ep-cache") as Record<string, number | { sub: number; dub: number }> | null) ?? {};
}

export function setEpCache(id: string, count: number | { sub: number; dub: number }) {
  const cache = getEpCache();
  cache[id] = count;
  set("ep-cache", cache);
  invalidate("ep-cache");
}

// ponytail: set entire ep-cache (for pruning stale entries)
export function setFullEpCache(cache: Record<string, number | { sub: number; dub: number }>) {
  set("ep-cache", cache);
  invalidate("ep-cache");
}

// ponytail: anime notifications
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

function pruneNotifications(list: AppNotification[]): AppNotification[] {
  const now = Date.now();
  // Keep every UNREAD notification indefinitely (dropping them silently loses
  // alerts the user never saw); read ones expire after two weeks.
  return list.filter((n) => !n.read || now - n.timestamp < TWO_WEEKS);
}

function migrateNotifications(list: AppNotification[]): AppNotification[] {
  const migrated = get<boolean>("notif-migrated-v5");
  if (migrated) return list;
  set("notif-migrated-v5", true);
  return [];
}

export function getNotifications(): AppNotification[] {
  const list = get<AppNotification[]>("notifications") ?? [];
  const migrated = migrateNotifications(list);
  const pruned = pruneNotifications(migrated);
  if (pruned.length < list.length) set("notifications", pruned);
  return pruned;
}

export function addNotification(n: Omit<AppNotification, "read" | "timestamp">) {
  const list = getNotifications();
  if (list.some((x) => x.id === n.id)) return;
  list.unshift({ ...n, read: false, timestamp: Date.now() });
  while (list.length > 14) {
    const lastRead = list.findLastIndex((x) => x.read);
    if (lastRead === -1) break;
    list.splice(lastRead, 1);
  }
  set("notifications", list);
  invalidate("notifications");
}

export function markAllRead() {
  set("notifications", getNotifications().map((n) => ({ ...n, read: true })));
  invalidate("notifications");
}

export function markNotificationRead(id: string) {
  set("notifications", getNotifications().map((n) => n.id === id ? { ...n, read: true } : n));
  invalidate("notifications");
}

export function removeNotification(id: string) {
  set("notifications", getNotifications().filter((n) => n.id !== id));
  invalidate("notifications");
}

export function unreadCount(): number {
  return getNotifications().filter((n) => !n.read).length;
}

export const getNotificationsSnapshot = (): AppNotification[] =>
  cachedSnapshot("notifications", getNotifications);

// ponytail: movie watchlist & history
export function getMovieWatchlist(): MovieWatchlistItem[] {
  return get<MovieWatchlistItem[]>("movie-watchlist") ?? [];
}

export const getMovieWatchlistSnapshot = (): MovieWatchlistItem[] =>
  cachedSnapshot("movie-watchlist", getMovieWatchlist);

export function addToMovieWatchlist(item: Omit<MovieWatchlistItem, "timestamp">) {
  const list = getMovieWatchlist().filter((i) => i.id !== item.id);
  list.unshift({ ...item, timestamp: Date.now() });
  set("movie-watchlist", list);
  invalidate("movie-watchlist");
}

export function removeFromMovieWatchlist(id: string) {
  set("movie-watchlist", getMovieWatchlist().filter((i) => i.id !== id));
  const cache = getTVEpCache();
  delete cache[id];
  set("tv-ep-cache", cache);
  invalidate("movie-watchlist");
}

export function setMovieWatchlistStatus(id: string, status: WatchStatus) {
  const list = getMovieWatchlist();
  const item = list.find((i) => i.id === id);
  if (!item || item.status === status) return;
  item.status = status;
  set("movie-watchlist", list);
  invalidate("movie-watchlist");
}

export function isInMovieWatchlist(id: string): boolean {
  return getMovieWatchlist().some((i) => i.id === id);
}

function getMovieHistory(): MovieHistoryItem[] {
  return get<MovieHistoryItem[]>("movie-history") ?? [];
}

export function addToMovieHistory(item: Omit<MovieHistoryItem, "timestamp">) {
  const hist = getMovieHistory().filter((i) => !(i.id === item.id && i.season === item.season && i.episode === item.episode));
  hist.unshift({ ...item, timestamp: Date.now() });
  if (hist.length > 50) hist.length = 50;
  set("movie-history", hist);
  invalidatePrefix("movie-watched:");
  invalidate("movie-history", "movie-continue");
}

export function getContinueWatchingMovies(): MovieHistoryItem[] {
  const hist = getMovieHistory();
  const seen = new Set<string>();
  return hist
    .map((h) => ({ ...h, poster: normalizePoster(h.poster) }))
    .filter((h) => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    })
    .slice(0, 12);
}

export const getContinueWatchingMoviesSnapshot = (): MovieHistoryItem[] =>
  cachedSnapshot("movie-continue", getContinueWatchingMovies);

export function removeFromMovieHistory(id: string, season?: number, episode?: number) {
  set("movie-history", getMovieHistory().filter((i) => {
    if (i.id !== id) return true;
    if (season !== undefined && i.season !== season) return true;
    if (episode !== undefined && i.episode !== episode) return true;
    return false;
  }));
  invalidatePrefix("movie-watched:");
  invalidate("movie-history", "movie-continue");
}

/** Episodes of one season that have been opened (the red watched tiles). */
export function getMovieSeasonWatched(id: string, season: number): number {
  return getMovieHistory().filter((h) => h.id === id && h.season === season && h.episode != null).length;
}

export const getMovieSeasonWatchedSnapshot = (id: string, season: number): number =>
  cachedSnapshot(`movie-watched:${id}:${season}`, () => getMovieSeasonWatched(id, season));

/** Bulk-mark every episode of a season as watched (skips ones already there). */
export function markSeasonWatched(
  id: string,
  season: number,
  episodes: number[],
  title: string,
  poster: string,
) {
  const history = getMovieHistory();
  const existing = new Set(
    history.filter((h) => h.id === id && h.season === season).map((h) => h.episode),
  );
  const now = Date.now();
  const additions = episodes
    .filter((ep) => !existing.has(ep))
    .map((ep, index) => ({
      id,
      title,
      poster: normalizePoster(poster),
      type: "tv" as const,
      season,
      episode: ep,
      timestamp: now + index,
    }));
  if (additions.length === 0) return;
  set("movie-history", [...history, ...additions]);
  invalidate("movie-history", "movie-continue");
}

/** Latest-viewed season/episode for a TV show (view-based high-water mark,
    mirroring getWatchedUpTo for anime). */
export function getMovieWatchedUpTo(id: string): { season?: number; episode?: number } | null {
  const hist = getMovieHistory().filter((h) => h.id === id);
  if (hist.length === 0) return null;
  const latest = hist.reduce((a, h) => (h.timestamp > a.timestamp ? h : a));
  return { season: latest.season, episode: latest.episode };
}

export const getMovieWatchedUpToSnapshot = (id: string): { season?: number; episode?: number } | null =>
  cachedSnapshot(`movie-watched:${id}:latest`, () => getMovieWatchedUpTo(id));

// ponytail: movie notifications
export function getMovieNotifications(): AppNotification[] {
  const list = get<AppNotification[]>("movie-notifications") ?? [];
  const pruned = pruneNotifications(list);
  if (pruned.length < list.length) set("movie-notifications", pruned);
  return pruned;
}

export function addMovieNotification(n: Omit<AppNotification, "read" | "timestamp">) {
  const list = getMovieNotifications();
  if (list.some((x) => x.id === n.id)) return;
  list.unshift({ ...n, read: false, timestamp: Date.now() });
  while (list.length > 14) {
    const lastRead = list.findLastIndex((x) => x.read);
    if (lastRead === -1) break;
    list.splice(lastRead, 1);
  }
  set("movie-notifications", list);
  invalidate("movie-notifications");
}

export function markAllMovieRead() {
  set("movie-notifications", getMovieNotifications().map((n) => ({ ...n, read: true })));
  invalidate("movie-notifications");
}

export function markMovieNotificationRead(id: string) {
  set("movie-notifications", getMovieNotifications().map((n) => n.id === id ? { ...n, read: true } : n));
  invalidate("movie-notifications");
}

export function removeMovieNotification(id: string) {
  set("movie-notifications", getMovieNotifications().filter((n) => n.id !== id));
  invalidate("movie-notifications");
}

export function unreadMovieCount(): number {
  return getMovieNotifications().filter((n) => !n.read).length;
}

export const getMovieNotificationsSnapshot = (): AppNotification[] =>
  cachedSnapshot("movie-notifications", getMovieNotifications);

// ponytail: TV show episode count cache (for new episode notifications)
export function getTVEpCache(): Record<string, number> {
  return (get("tv-ep-cache") as Record<string, number> | null) ?? {};
}

export function setTVEpCache(id: string, count: number) {
  const cache = getTVEpCache();
  cache[id] = count;
  set("tv-ep-cache", cache);
  invalidate("tv-ep-cache");
}

export function exportData(): string {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    watchlist: getWatchlist(),
    history: getHistory(),
    notifications: getNotifications(),
    movieWatchlist: getMovieWatchlist(),
    movieHistory: getMovieHistory(),
    movieNotifications: getMovieNotifications(),
    // Everything below was added after v1 shipped; importData skips missing
    // fields so old backups still load. Kept at version 1 on purpose.
    resumePositions: get<Record<string, unknown>>(RESUME_KEY) ?? {},
    prefs: {
      autoplay: getAutoplayPref(),
      autoSkip: getSkipPref(),
      resume: getResumePref(),
    },
    epCache: getEpCache(),
    tvEpCache: getTVEpCache(),
    theme: getTheme(),
  }, null, 2);
}

function isItemArray(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.every((i) => i !== null && typeof i === "object");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Resume entries are { t: seconds, at: epochMs, d?: seconds }. Anything else
// would be read by getResumePos() and fed to the player as a seek target.
function isResumeMap(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(
    (e) => isPlainObject(e) && typeof e.t === "number" && typeof e.at === "number"
  );
}

// ep-cache values are either a plain count or { sub, dub }.
function isEpCache(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(
    (e) =>
      typeof e === "number" ||
      (isPlainObject(e) && typeof e.sub === "number" && typeof e.dub === "number")
  );
}

export function importData(json: string): { ok: boolean; error?: string } {
  try {
    const data = JSON.parse(json);
    if (data.version !== 1) return { ok: false, error: "Unsupported export version" };
    // Shape-check every section: importData writes raw arrays that later get
    // `.map`'d by renderers — a hand-edited file would crash every page.
    const sections: [string, string][] = [
      ["watchlist", "watchlist"],
      ["history", "history"],
      ["notifications", "notifications"],
      ["movieWatchlist", "movie-watchlist"],
      ["movieHistory", "movie-history"],
      ["movieNotifications", "movie-notifications"],
    ];
    for (const [field, key] of sections) {
      const v = data[field];
      if (v === undefined || v === null) continue;
      if (!isItemArray(v)) return { ok: false, error: `Invalid "${field}" section` };
      set(key, v);
    }

    // Optional extras — same skip-if-absent rule as the lists above, so a
    // pre-extension backup imports cleanly.
    const resume = data.resumePositions;
    if (resume !== undefined && resume !== null) {
      if (!isResumeMap(resume)) return { ok: false, error: 'Invalid "resumePositions" section' };
      set(RESUME_KEY, resume);
    }
    const epCache = data.epCache;
    if (epCache !== undefined && epCache !== null) {
      if (!isEpCache(epCache)) return { ok: false, error: 'Invalid "epCache" section' };
      set("ep-cache", epCache);
    }
    const tvEpCache = data.tvEpCache;
    if (tvEpCache !== undefined && tvEpCache !== null) {
      if (
        !isPlainObject(tvEpCache) ||
        !Object.values(tvEpCache).every((e) => typeof e === "number")
      ) {
        return { ok: false, error: 'Invalid "tvEpCache" section' };
      }
      set("tv-ep-cache", tvEpCache);
    }
    const prefs = data.prefs;
    if (prefs !== undefined && prefs !== null) {
      if (!isPlainObject(prefs)) return { ok: false, error: 'Invalid "prefs" section' };
      if (typeof prefs.autoplay === "boolean") setAutoplayPref(prefs.autoplay);
      if (typeof prefs.autoSkip === "boolean") setSkipPref(prefs.autoSkip);
      if (typeof prefs.resume === "boolean") setResumePref(prefs.resume);
    }
    const theme = data.theme;
    if (theme !== undefined && theme !== null) {
      if (theme !== "dark" && theme !== "light") {
        return { ok: false, error: 'Invalid "theme" section' };
      }
      setTheme(theme);
    }

    // Snapshots are cached — without this every mounted view keeps rendering
    // the pre-import list until a full reload.
    refreshStore();
    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid JSON file" };
  }
}

// ponytail: theme persistence
export function getTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  const t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") return t;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(theme: "dark" | "light") {
  if (typeof window === "undefined") return;
  localStorage.setItem("theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
  invalidate("theme");
}

export const getThemeSnapshot = (): "dark" | "light" => cachedSnapshot("theme", getTheme);
