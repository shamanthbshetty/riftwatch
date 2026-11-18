use std::sync::LazyLock;

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

const SEASON_BONUS: i32 = 250;
const SEASON_PENALTY: i32 = 250;

/// Extract a season number from NORMALIZED text ("… season 2", "… s2").
static RE_SEASON: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\bseason\s*(\d{1,2})\b").unwrap());
static RE_NTH_SEASON: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(\d{1,2})(?:st|nd|rd|th)\s+season\b").unwrap());
static RE_S: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\bs(\d{1,2})\b").unwrap());

fn season_of(normalized: &str) -> Option<u32> {
    if let Some(c) = RE_SEASON.captures(normalized) {
        return c[1].parse().ok();
    }
    if let Some(c) = RE_NTH_SEASON.captures(normalized) {
        return c[1].parse().ok();
    }
    RE_S.captures(normalized).and_then(|c| c[1].parse().ok())
}

// Format words identify WHICH work of a franchise a title is. They carry no
// identity for coverage (any title can carry them, so they stay generic there),
// but they decide agreement: without this the query "… Quintuplets Movie" rated
// the TV series ABOVE the movie page ("movie" didn't count as identity, so the
// shorter series candidate just lost fewer extra-word points) and the movie
// played TV episode 1.
const FORMAT: &[&str] = &[
    "movie", "movies", "ova", "ovas", "ona", "onas", "special", "specials",
];
// Both sides agree on the work's format → boost; the query names a format the
// candidate lacks (or a different one) → push the score far down so a franchise's
// TV entry can never stand in for its movie. A candidate that merely ADDS a
// format word the query didn't say ("Mugen Train" → "Mugen Train the Movie")
// only gets a nudge — that's ordinary provider naming, not a different work.
const FORMAT_BONUS: i32 = 250;
const FORMAT_PENALTY: i32 = 500;
const EXTRA_FORMAT_PENALTY: i32 = 200;

fn format_token(normalized: &str) -> Option<&'static str> {
    let words: Vec<&str> = normalized.split_whitespace().collect();
    FORMAT.iter().copied().find(|f| words.contains(f))
}

pub fn score_title(query: &str, candidate: &str) -> i32 {
    let q = normalize(query);
    let c = normalize(candidate);
    if q.is_empty() || c.is_empty() {
        return 0;
    }
    let base = base_score(&q, &c);
    let (q_fmt, c_fmt) = (format_token(&q), format_token(&c));
    match (q_fmt, c_fmt) {
        // Same format named on both sides ("… Movie" vs "…: The Movie").
        (Some(a), Some(b)) if a == b => base + FORMAT_BONUS,
        // Query wants a specific format this candidate is not.
        (Some(_), _) => base - FORMAT_PENALTY,
        // Candidate names a format the query didn't ask about.
        (None, Some(_)) => base - EXTRA_FORMAT_PENALTY,
        (None, None) => base,
    }
}

fn base_score(q: &str, c: &str) -> i32 {
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

// ── Identity matching for the stream/episode fetchers ──
// The playback path resolves a show by its AniList/MAL/provider id, so it only
// needs to tell the right work apart from a provider's title search — not rank
// by similarity. `identity_rank` is a deterministic replacement for the fuzzy
// `score_title` heuristic: exact title first, then the same base work
// (season-aware), then a word-boundary prefix. It returns None for anything
// that cannot be the requested show, so a provider can never hand back a
// spin-off as a substitute.

static RE_SEASON_PAT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"\s*\b(?:season|cour|part)\s*\d{1,2}(?:st|nd|rd|th)?\b|\s*\b\d{1,2}(?:st|nd|rd|th)\s+(?:season|cour|part)\b|\s*\bs\d{1,2}\b|\s+\d{1,2}$",
    )
    .unwrap()
});

/// Remove season markers from a NORMALIZED title so every season of one work
/// shares a base ("naruto season 2" → "naruto").
fn strip_season(norm: &str) -> String {
    RE_SEASON_PAT
        .replace_all(norm, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// How a provider candidate relates to the target title. Lower is better;
/// -1 means "not the requested work" (drop it).
/// 0 exact · 1 same base + season · 2 same base, other season · 3 prefix
pub fn identity_rank(target: &str, candidate: &str) -> i32 {
    let t = normalize(target);
    let c = normalize(candidate);
    if t.is_empty() || c.is_empty() {
        return -1;
    }
    if t == c {
        return 0;
    }
    let tb = strip_season(&t);
    let cb = strip_season(&c);
    if !tb.is_empty() && tb == cb {
        let ts = season_of(&t);
        let cs = season_of(&c);
        // Same base but a conflicting explicit season is a different work.
        if ts.is_some() && cs.is_some() && ts != cs {
            return 2;
        }
        return 1;
    }
    let (short, long) = if tb.len() <= cb.len() {
        (&tb, &cb)
    } else {
        (&cb, &tb)
    };
    if !short.is_empty() && long.starts_with(short) {
        let rest = &long[short.len()..];
        if rest.is_empty() || rest.starts_with(' ') {
            return 3;
        }
    }
    -1
}

/// Order candidate indices best-first, dropping non-matches. Ties keep the
/// provider's original result order so resolution stays deterministic.
pub fn rank_candidates(target: &str, titles: &[String]) -> Vec<usize> {
    let mut scored: Vec<(i32, usize)> = titles
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let r = identity_rank(target, t);
            (r >= 0).then_some((r, i))
        })
        .collect();
    scored.sort_by_key(|&(r, i)| (r, i));
    scored.into_iter().map(|(_, i)| i).collect()
}
