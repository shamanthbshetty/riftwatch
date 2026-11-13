// Shared title ranking for provider search. All three providers (anikoto,
// aniwatch, kenjitsu) rank candidates with this instead of trusting the first
// hit, so a variant/romaji title cannot hijack the result into a different show.

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(english|sub|subbed|dub|dubbed|hd|new)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Titles sent to provider search must use plain punctuation: upstream sites
// (WordPress search on Aniwatch clones, JSON APIs) index straight apostrophes
// and hyphens, while AniList titles carry typographic ones — "Frieren: Beyond
// Journey’s End" (U+2019) matched zero posts on Aniwatch, so the show silently
// fell back to embed-only servers and lost the direct stream entirely.
export const searchReady = (s: string) =>
  s
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

// Tokens that appear in countless titles carry no identity: season markers,
// format words, articles. A candidate matching ONLY these must never score —
// searching "Black Clover Season 2" once ranked "Toilet-Bound Hanako-kun
// Season 2 Part 2" first (shared "season" + duplicated "2") and Watch Now
// played that instead of nothing.
const GENERIC = new Set([
  "season", "seasons", "part", "parts", "series", "cour", "final",
  "movie", "movies", "ova", "onas", "special", "specials",
  "episode", "episodes", "ep", "eps",
  "the", "a", "an", "of", "and", "to", "in", "on", "for", "with", "by",
  "s1", "s2", "s3", "s4", "s5",
]);

// Below this a candidate is a near-miss, not the requested show: query words
// shared only through generic tokens ("Season 2") or a franchise spin-off
// ("Black Clover: Thanksgiving Festa" for "Black Clover Season 2" = 100).
// 200 lets a plain main-series title qualify as a last-resort fallback while
// excluding everything that merely sounds season-y.
export const MIN_SCORE = 200;

// Season agreement is worth more than word overlap: upstream catalogues name
// the same season differently ("Season 2" vs "2nd Season" vs "S2"), and the
// word scorer alone buries those pairs (e.g. "The Rising of the Shield Hero
// Season 2" vs "The Rising of the Shield Hero 2nd Season" scored 114 and was
// discarded, so a fully-dubbed season reported "no dub"). Conversely, a
// season mismatch means a different catalogue entry and must never substitute
// (S1 must not play as S2).
const SEASON_BONUS = 250;
const SEASON_PENALTY = 250;

// Extract a season number from NORMALIZED text ("… season 2", "… 2nd season",
// "… s2"). Plain numbers without a season marker (years, episode counts) are
// ignored. Returns null when the title carries no season.
function seasonOf(normalized: string): number | null {
  const m =
    normalized.match(/\bseason\s*(\d{1,2})\b/) ||
    normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/) ||
    normalized.match(/\bs(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function scoreTitle(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 700 - c.length;

  const qWords = new Set(q.split(" "));
  const cWords = new Set(c.split(" "));
  // Words that could actually identify the show. Pure numbers ("2", "100")
  // never identify one — they're what let any "…Season 2" match.
  const distinctive = [...qWords].filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
  const identity = distinctive.length > 0 ? distinctive : [...qWords];

  let hits = 0;
  for (const w of identity) if (cWords.has(w)) hits++;
  if (hits === 0) return 0;

  // Reward coverage of the query, penalise extra words (spin-offs, sequels).
  let score = (hits / qWords.size) * 500 - (cWords.size - hits) * 25;

  // Season agreement/disagreement. The hits === 0 gate above already ran, so
  // a shared season number alone can never rescue an unrelated show (the
  // "any … Season 2 matches" case still scores 0). A query with no season
  // keeps legacy behavior (base titles must keep matching season-qualified
  // candidates as fallbacks).
  const qSeason = seasonOf(q);
  if (qSeason !== null) {
    const cSeason = seasonOf(c);
    if (cSeason !== null) {
      score += qSeason === cSeason ? SEASON_BONUS : -SEASON_PENALTY;
    } else {
      // Query wants season N but the candidate names no season (e.g. the S1
      // base title): accepting it would play the wrong season under the
      // requested title.
      score -= SEASON_PENALTY;
    }
  }

  return score;
}
