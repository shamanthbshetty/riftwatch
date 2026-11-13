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
  cast?: { id: number; name: string; character: string; profile_path: string | null }[];
}

const IMG_BASE = "https://image.tmdb.org/t/p";

export function posterUrl(path: string | null, size = "w500"): string | null {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}

export function backdropUrl(path: string | null, size = "w1280"): string | null {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}