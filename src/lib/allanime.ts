export interface SearchResult {
  _id: string;
  name: string;
  englishName?: string;
  malId: string;
  thumbnail: string;
  availableEpisodes: { sub: number; dub: number };
  /** AniList status when the row came from the AniList merge (e.g. NOT_YET_RELEASED). */
  status?: string;
}