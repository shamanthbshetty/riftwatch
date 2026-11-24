// Shows are stored under whichever id namespace the surface that saved them
// used (AllAnime hash, AniList numeric, MAL numeric, kitsu-…). Watching a show
// writes history under its canonical id, while the home rails are keyed by
// AniList id, so a plain id comparison misses the same show in both places.

function validMalId(value?: string): string {
  const id = (value || "").trim();
  return id && id !== "0" ? id : "";
}

/** Title key for cross-source comparisons (punctuation/case insensitive). */
export function normalizeShowTitle(value?: string): string {
  return (value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface MatchableEntry {
  id?: string;
  malId?: string;
  title?: string;
  englishName?: string;
}

export interface MatchableShow {
  /** Id in the current route. */
  id?: string;
  /** Canonical id returned by the backend for the same show. */
  canonicalId?: string;
  malId?: string;
  title?: string;
  englishName?: string;
}

/**
 * True when a stored history/watchlist entry belongs to the show on screen,
 * even when the two sides were saved under different id namespaces.
 */
export function showRefMatches(entry: MatchableEntry, show: MatchableShow): boolean {
  if (!entry) return false;

  const ids = [show.id, show.canonicalId].filter((value): value is string => Boolean(value));
  if (entry.id && ids.includes(entry.id)) return true;

  const entryMal = validMalId(entry.malId);
  const showMal = validMalId(show.malId);
  // When both sides know their MAL id it is authoritative: equal ids mean the
  // same show, different ids mean a different one (a remake with a shared
  // title must not match).
  if (entryMal && showMal) return entryMal === showMal;

  const showTitles = [show.title, show.englishName].map(normalizeShowTitle).filter(Boolean);
  if (showTitles.length === 0) return false;
  const entryTitles = [entry.title, entry.englishName].map(normalizeShowTitle).filter(Boolean);
  return entryTitles.some((title) => showTitles.includes(title));
}

/** The watchlist row for a card/rail show, matched across id namespaces. */
export function findWatchlistEntry<T extends MatchableEntry>(items: T[], show: MatchableShow): T | null {
  return items.find((item) => showRefMatches(item, show)) ?? null;
}

/** True when the show already has any watch-history row. */
export function isInWatchHistory(history: MatchableEntry[], show: MatchableShow): boolean {
  return history.some((item) => showRefMatches(item, show));
}
