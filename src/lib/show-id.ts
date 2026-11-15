// One show is reachable under several id namespaces — AllAnime hash (search),
// AniList numeric id (spotlight/trending/schedule rails), kitsu-… (fallbacks),
// MAL id (schedule) — and a watchlist entry is keyed by whichever id was in the
// URL when it was added. Membership therefore has to match any identity the
// current page can prove, or the same show reads "+ Watchlist" on one route
// and its saved status on another.

export interface ShowIdentity {
  /** The id in the current URL. */
  id: string;
  /** Canonical id returned by /api/episodes (show._id), when loaded. */
  canonicalId?: string;
  /** MAL id of the loaded show, when known. */
  malId?: string;
}

export interface WatchlistEntryLike {
  id: string;
  malId?: string;
}

export function sameShow(entry: WatchlistEntryLike, route: ShowIdentity): boolean {
  if (!entry?.id) return false;
  if (entry.id === route.id) return true;
  if (route.canonicalId && entry.id === route.canonicalId) return true;
  // Both sides are MAL ids — entry ids (AniList/MAL numeric vs AllAnime hash)
  // are never compared against them.
  if (route.malId && entry.malId && entry.malId === route.malId) return true;
  return false;
}
