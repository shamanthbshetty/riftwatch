// Shared title ranking for provider search (port of src/lib/title-score.ts).
// All three providers (anikoto, aniwatch, kenjitsu) rank candidates with this
// instead of trusting the first hit, so a variant/romaji title cannot hijack
// the result into a different show.

pub fn normalize(s: &str) -> String {
    let no_punct: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    let mut out = Vec::new();
    for w in no_punct.split_whitespace() {
        if matches!(
            w,
            "english" | "sub" | "subbed" | "dub" | "dubbed" | "hd" | "new"
        ) {
            continue;
        }
        out.push(w);
    }
    out.join(" ")
}

// Titles sent to provider search must use plain punctuation: upstream sites
// index straight apostrophes and hyphens, while AniList titles carry
// typographic ones ("Journey’s" matched zero posts on Aniwatch).
pub fn search_ready(s: &str) -> String {
    let replaced: String = s
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            c => c,
        })
        .collect();
    replaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Tokens that appear in countless titles carry no identity: season markers,
// format words, articles. A candidate matching ONLY these must never score.
const GENERIC: &[&str] = &[
    "season", "seasons", "part", "parts", "series", "cour", "final", "movie", "movies", "ova",
    "onas", "special", "specials", "episode", "episodes", "ep", "eps", "the", "a", "an", "of",
    "and", "to", "in", "on", "for", "with", "by", "s1", "s2", "s3", "s4", "s5",
];

// Below this a candidate is a near-miss, not the requested show.
pub const MIN_SCORE: i32 = 200;

const SEASON_BONUS: i32 = 250;
const SEASON_PENALTY: i32 = 250;

/// Extract a season number from NORMALIZED text ("… season 2", "… s2").
fn season_of(normalized: &str) -> Option<u32> {
    let re = regex::Regex::new(r"\bseason\s*(\d{1,2})\b").unwrap();
    if let Some(c) = re.captures(normalized) {
        return c[1].parse().ok();
    }
    let re = regex::Regex::new(r"\b(\d{1,2})(?:st|nd|rd|th)\s+season\b").unwrap();
    if let Some(c) = re.captures(normalized) {
        return c[1].parse().ok();
    }
    let re = regex::Regex::new(r"\bs(\d{1,2})\b").unwrap();
    re.captures(normalized).and_then(|c| c[1].parse().ok())
}

pub fn score_title(query: &str, candidate: &str) -> i32 {
    let q = normalize(query);
    let c = normalize(candidate);
    if q.is_empty() || c.is_empty() {
        return 0;
    }
    if c == q {
        return 1000;
    }
    if c.starts_with(&q) {
        return 700 - c.len() as i32;
    }

    let q_words: Vec<&str> = q.split_whitespace().collect();
    let c_words: Vec<&str> = c.split_whitespace().collect();
    // Words that could actually identify the show. Pure numbers never
    // identify one — they're what let any "…Season 2" match.
    let distinctive: Vec<&str> = q_words
        .iter()
        .copied()
        .filter(|w| !GENERIC.contains(w) && !w.chars().all(|ch| ch.is_ascii_digit()))
        .collect();
    let identity: Vec<&str> = if !distinctive.is_empty() {
        distinctive
    } else {
        q_words.clone()
    };

    let mut hits = 0;
    for w in &identity {
        if c_words.contains(w) {
            hits += 1;
        }
    }
    if hits == 0 {
        return 0;
    }

    // Reward coverage of the query, penalise extra words (spin-offs, sequels).
    let mut score =
        (hits as f64 / q_words.len() as f64 * 500.0) - ((c_words.len().saturating_sub(hits)) as f64 * 25.0);

    // Season agreement/disagreement.
    if let Some(q_season) = season_of(&q) {
        match season_of(&c) {
            Some(c_season) if c_season == q_season => score += SEASON_BONUS as f64,
            Some(_) => score -= SEASON_PENALTY as f64,
            // Query wants season N but the candidate names no season —
            // accepting it would play the wrong season.
            None => score -= SEASON_PENALTY as f64,
        }
    }

    score.round() as i32
}
