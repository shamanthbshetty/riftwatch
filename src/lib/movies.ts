// Plain HTTP on purpose: api.themoviedb.org's TLS handshake is being reset at
// the network level from some networks (image.tmdb.org is unaffected), and the
// same CloudFront dist serves HTTP fine. The key is public anyway.
const TMDB_BASE = "http://api.themoviedb.org/3";
const TMDB_KEY = process.env.TMDB_API_KEY ?? "";
const IMG_BASE = "https://image.tmdb.org/t/p";

export interface MovieResult {
  id: number;
  title: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  media_type?: string;
  genre_ids?: number[];
}

export interface MovieDetail extends MovieResult {
  imdb_id: string | null;
  runtime: number | null;
  genres: { id: number; name: string }[];
  seasons?: { season_number: number; episode_count: number; name: string }[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  status: string;
  tagline: string;
  belongs_to_collection?: { id: number; name: string; poster_path: string | null } | null;
  cast?: CastMember[];
}

interface MovieSearchResult {
  page: number;
  results: MovieResult[];
  total_pages: number;
  total_results: number;
}

interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
}

async function tmdbFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { next: { revalidate: 3600 }, signal: AbortSignal.timeout(10000) });
      if (res.ok) return res.json();
      // 4xx (bad key, not found) will never become 2xx on retry — bail out of
      // the loop instead of hitting TMDB 3× with the same broken request.
      if (res.status < 500) throw new Error(`TMDB ${res.status}: ${path}`);
    } catch (e) {
      if (attempt === 2 || (e instanceof Error && /^TMDB 4\d\d/.test(e.message))) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`TMDB failed after retries: ${path}`);
}

export async function searchMovies(query: string, page = 1): Promise<MovieSearchResult> {
  const data = await tmdbFetch<MovieSearchResult>("/search/multi", { query, page: String(page), include_adult: "false" });
  // Search surfaces unreleased titles too — listings only show what's out.
  return { ...data, results: (data.results ?? []).filter(isReleased) };
}

/** Released-date gate shared by every listing: only titles already out.
    Missing date = keep (same lenient default the trending filters always had). */
export function isReleased(r: MovieResult): boolean {
  const today = new Date().toLocaleDateString("en-CA");
  const date = r.media_type === "tv" ? r.first_air_date || r.release_date : r.release_date || r.first_air_date;
  return !date || date <= today;
}

export async function getTrending(): Promise<MovieResult[]> {
  const data = await tmdbFetch<{ results: MovieResult[] }>("/trending/movie/week");
  return data.results.filter((r) => (r.media_type === "movie" || !r.media_type) && isReleased(r));
}

export async function getTrendingTV(): Promise<MovieResult[]> {
  const data = await tmdbFetch<{ results: MovieResult[] }>("/trending/tv/week");
  // TV results carry first_air_date, not release_date — the old filter checked
  // a field that is never set, so unaired shows slipped through.
  return data.results.filter(isReleased);
}

export async function getPopularMovies(page = 1): Promise<MovieSearchResult> {
  const data = await tmdbFetch<MovieSearchResult>("/movie/popular", { page: String(page) });
  return { ...data, results: (data.results ?? []).filter(isReleased) };
}

export async function getPopularTV(page = 1): Promise<MovieSearchResult> {
  const data = await tmdbFetch<MovieSearchResult>("/tv/popular", { page: String(page) });
  return { ...data, results: (data.results ?? []).filter(isReleased) };
}

export async function getTopRatedMovies(page = 1): Promise<MovieSearchResult> {
  const data = await tmdbFetch<MovieSearchResult>("/movie/top_rated", { page: String(page) });
  return { ...data, results: (data.results ?? []).filter(isReleased) };
}

export async function getTopRatedTV(page = 1): Promise<MovieSearchResult> {
  const data = await tmdbFetch<MovieSearchResult>("/tv/top_rated", { page: String(page) });
  return { ...data, results: (data.results ?? []).filter(isReleased) };
}

export async function getMovieDetails(id: number): Promise<MovieDetail> {
  return tmdbFetch(`/movie/${id}`);
}

export async function getTVDetails(id: number): Promise<MovieDetail> {
  return tmdbFetch(`/tv/${id}`);
}

export async function getMovieCredits(id: number): Promise<{ cast: CastMember[] }> {
  return tmdbFetch(`/movie/${id}/credits`);
}

export async function getTVCredits(id: number): Promise<{ cast: CastMember[] }> {
  return tmdbFetch(`/tv/${id}/credits`);
}

/** TMDB "More like this" — recommendations for a movie or TV title. */
export async function getRecommendations(id: number, type: "movie" | "tv"): Promise<MovieResult[]> {
  const data = await tmdbFetch<{ results: MovieResult[] }>(`/${type}/${id}/recommendations`);
  // Tag media_type so MovieCard links to the right detail URL (tv results
  // would otherwise be treated as movies and 404).
  return (data.results ?? []).map((r) => ({ ...r, media_type: type })).filter(isReleased);
}

export function posterUrl(path: string | null, size = "w500"): string | null {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}

export function backdropUrl(path: string | null, size = "w1280"): string | null {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}

interface TVEpisode {
  episode_number: number;
  name: string;
}

export async function getTVEpisodes(tmdbId: number, season: number): Promise<TVEpisode[]> {
  const data = await tmdbFetch<{ episodes: TVEpisode[] }>(`/tv/${tmdbId}/season/${season}`);
  return data.episodes ?? [];
}

export async function getTVTotalEpisodes(tmdbId: number): Promise<number> {
  const details = await getTVDetails(tmdbId);
  // Skip season 0 (specials/OMAKASE) — counting them inflated the episode
  // count well past what the watch page can actually play.
  return (
    details.seasons?.reduce(
      (sum, s) => (s.season_number === 0 ? sum : sum + (s.episode_count ?? 0)),
      0
    ) ?? 0
  );
}
