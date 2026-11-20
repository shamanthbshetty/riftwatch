// AniList GraphQL client (port of src/lib/anilist.ts). Owned by the anime
// migration — every consumer (titles/relations/search/schedule/random) lives
// in routes/anime_api.rs.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::title_score;
use crate::tmdb;

const ANILIST_URL: &str = "https://graphql.anilist.co";
const KITSU_MAP_URL: &str = "https://kitsu.io/api/edge/mappings";
const KITSU_ANIME_URL: &str = "https://kitsu.io/api/edge/anime";

const MEMO_MAX: usize = 500;
const TEN_MIN: Duration = Duration::from_secs(10 * 60);
const THIRTY_MIN: Duration = Duration::from_secs(30 * 60);
const HOUR: Duration = Duration::from_secs(3600);
const SIX_HOURS: Duration = Duration::from_secs(6 * 3600);
const DAY_24: Duration = Duration::from_secs(24 * 3600);

// AniList is POSTed, bypassing any upstream cache — only successful responses
// are memoized so a Kitsu fallback never gets pinned for hours.
static MEMO: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn memo_get(key: &str, ttl: Duration) -> Option<Value> {
    let store = MEMO.lock().unwrap();
    store
        .get(key)
        .filter(|(ts, _)| ts.elapsed() < ttl)
        .map(|(_, v)| v.clone())
}

fn memo_set(key: &str, value: Value) {
    let mut store = MEMO.lock().unwrap();
    if store.len() >= MEMO_MAX {
        if let Some(oldest) = store.iter().min_by_key(|(_, v)| v.0).map(|(k, _)| k.clone()) {
            store.remove(&oldest);
        }
    }
    store.insert(key.to_string(), (Instant::now(), value));
}

// Matches TS replace(/<[^>]*>?/gm, ""): '<' through the next '>' (or end).
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '<' {
            for c2 in chars.by_ref() {
                if c2 == '>' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// Shared POST path for every AniList query. Two things matter here:
//   1. AniList rate-limits per IP (30 req/min). A watch page fires episodes,
//      titles, relations, trailer and recommendations at once, so without a
//      cache a second page load starts getting 429s — which used to surface
//      as "anime not found". Cache identical read-only queries, and wait out
//      one Retry-After window before giving up.
//   2. Only successful responses are memoized, so a transient failure never
//      gets pinned.
pub async fn anilist_post(
    client: &reqwest::Client,
    query: &str,
    variables: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let key = format!("gql:{}:{}", query, variables);
    if let Some(hit) = memo_get(&key, TEN_MIN) {
        return Ok(hit);
    }

    let mut body = Map::new();
    body.insert("query".into(), json!(query));
    if !variables.is_null() {
        body.insert("variables".into(), variables.clone());
    }
    let payload = Value::Object(body);

    let mut last_err = String::new();
    for attempt in 0..2 {
        let res = client
            .post(ANILIST_URL)
            .header("Content-Type", "application/json")
            .json(&payload)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if status.is_success() {
            let j = res.json::<Value>().await.map_err(|e| e.to_string())?;
            memo_set(&key, j.clone());
            return Ok(j);
        }
        // AniList answers an unknown id with HTTP 404 + `data.Media: null`.
        // That is a definitive "no such media", not an outage — surface it as
        // a response so callers can 404 instead of showing "try again".
        if status.as_u16() == 404 {
            let j = res
                .json::<Value>()
                .await
                .unwrap_or_else(|_| json!({ "data": null }));
            memo_set(&key, j.clone());
            return Ok(j);
        }
        last_err = format!("AniList {}", status);
        let retryable = status.as_u16() == 429 || status.is_server_error();
        if retryable && attempt == 0 {
            let wait = if status.as_u16() == 429 {
                res.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1)
                    .clamp(1, 2)
            } else {
                1
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        break;
    }
    Err(last_err)
}

async fn kitsu_get(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<Value, String> {
    let res = client
        .get(url)
        .header("Accept", "application/vnd.api+json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Kitsu {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

// ── Search merge (finds upcoming/uncatalogued titles allanime doesn't have) ──

const ANI_SEARCH_QUERY: &str = "query($search: String) { Page(perPage: 20) { media(search: $search, type: ANIME, isAdult: false) { id title { romaji english } coverImage { large } status } } }";

pub async fn search_ani_list(client: &reqwest::Client, query: &str) -> Result<Vec<Value>, String> {
    let key = format!("ani:q:{}", query.trim().to_lowercase());
    if let Some(hit) = memo_get(&key, THIRTY_MIN) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    let j = anilist_post(
        client,
        ANI_SEARCH_QUERY,
        &json!({ "search": query }),
        Duration::from_secs(4),
    )
    .await?;
    let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = media.iter().map(search_row).collect();
    memo_set(&key, Value::Array(out.clone()));
    Ok(out)
}

fn search_row(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    o.insert("status".into(), json!(m["status"].as_str().unwrap_or("")));
    Value::Object(o)
}

// ── Relations (sequels/prequels/related) ──

const RELATIONS_QUERY: &str = r#"query($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    relations { edges { relationType node { id type title { romaji english } coverImage { large } } } }
  }
}"#;

// Only linkable anime relations: manga SOURCE/ADAPTATION entries would
// dead-end on the watch page, CHARACTER/SETTING/SUMMARY edges are noise.
const RELATION_FILTER: [&str; 6] = [
    "SEQUEL",
    "PREQUEL",
    "SIDE_STORY",
    "ALTERNATIVE",
    "SPIN_OFF",
    "PARENT",
];
const RELATION_ORDER: [&str; 6] = [
    "SEQUEL",
    "PREQUEL",
    "PARENT",
    "SIDE_STORY",
    "SPIN_OFF",
    "ALTERNATIVE",
];

pub async fn get_ani_relations(
    client: &reqwest::Client,
    id: Option<u64>,
    mal_id: Option<u64>,
) -> Result<Vec<Value>, String> {
    // Namespaced: AniList id 123 and MAL id 123 are different shows.
    let key = format!(
        "ani:rel:id:{}:mal:{}",
        id.map(|v| v.to_string()).unwrap_or_default(),
        mal_id.map(|v| v.to_string()).unwrap_or_default()
    );
    if let Some(hit) = memo_get(&key, DAY_24) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    // AniList treats an explicit `id: null` as a lookup that resolves to
    // nothing, so only include the variables actually provided.
    let mut vars = Map::new();
    if let Some(v) = id.filter(|v| *v > 0) {
        vars.insert("id".into(), json!(v));
    }
    if let Some(v) = mal_id.filter(|v| *v > 0) {
        vars.insert("idMal".into(), json!(v));
    }
    match fetch_relations(client, Value::Object(vars)).await {
        Ok(out) => {
            memo_set(&key, Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => Ok(vec![]),
    }
}

async fn fetch_relations(client: &reqwest::Client, vars: Value) -> Result<Vec<Value>, String> {
    let j = anilist_post(client, RELATIONS_QUERY, &vars, Duration::from_secs(8)).await?;
    let media = &j["data"]["Media"];
    if media.is_null() {
        return Err("AniList: media not found".into());
    }
    let edges = media["relations"]["edges"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<Value> = edges
        .iter()
        .filter(|e| {
            let rt = e["relationType"].as_str().unwrap_or("");
            RELATION_FILTER.contains(&rt) && e["node"]["type"].as_str() == Some("ANIME")
        })
        .map(|e| {
            let node = &e["node"];
            let english = node["title"]["english"].as_str().filter(|s| !s.is_empty());
            json!({
                "id": node["id"].as_i64().unwrap_or(0),
                "relation": e["relationType"].as_str().unwrap_or(""),
                "title": english.unwrap_or(node["title"]["romaji"].as_str().unwrap_or("")),
                "thumbnail": node["coverImage"]["large"].as_str().unwrap_or(""),
            })
        })
        .collect();
    out.sort_by_key(|v| {
        let rt = v["relation"].as_str().unwrap_or("");
        RELATION_ORDER
            .iter()
            .position(|r| *r == rt)
            .unwrap_or(RELATION_ORDER.len())
    });
    Ok(out)
}

// ── Trailer (AniList Media.trailer, with TMDB cross-source fallback) ──

const TRAILER_BY_ID_QUERY: &str = r#"query($id: Int) {
  Media(id: $id, type: ANIME) {
    trailer { id site }
    title { romaji english }
    startDate { year }
    format
  }
}"#;

const TRAILER_BY_MAL_QUERY: &str = r#"query($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    trailer { id site }
    title { romaji english }
    startDate { year }
    format
  }
}"#;

const TRAILER_SEARCH_QUERY: &str = r#"query($search: String) {
  Page(perPage: 10) {
    media(search: $search, type: ANIME, isAdult: false) {
      title { romaji english }
      startDate { year }
      format
      popularity
      trailer { id site }
    }
  }
}"#;

fn push_unique_title(out: &mut Vec<String>, title: Option<&str>) {
    let title = match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => return,
    };
    if !out.iter().any(|t| t.eq_ignore_ascii_case(title)) {
        out.push(title.to_string());
    }
}

fn youtube_trailer(trailer: &Value) -> Option<Value> {
    if !trailer["site"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("youtube"))
    {
        return None;
    }
    let id = trailer["id"].as_str().filter(|s| !s.is_empty())?;
    Some(json!({ "id": id, "site": "youtube", "source": "anilist" }))
}

/// AniList trailer first; when the community entry has none, search TMDB by
/// the title/year we just fetched. AniList's trailer field is sparsely filled,
/// so most older shows rely on this TMDB pass.
pub async fn get_ani_trailer(
    client: &reqwest::Client,
    id: Option<u64>,
    mal_id: Option<u64>,
    title: Option<&str>,
) -> Result<Value, String> {
    let mut titles: Vec<String> = Vec::new();
    let mut year = None;
    let mut prefer_tv = true;
    let mut lookup_err = None;

    let lookup = if let Some(v) = id.filter(|v| *v > 0) {
        Some((TRAILER_BY_ID_QUERY, json!({ "id": v })))
    } else {
        mal_id
            .filter(|v| *v > 0)
            .map(|v| (TRAILER_BY_MAL_QUERY, json!({ "idMal": v })))
    };

    if let Some((query, vars)) = lookup {
        match anilist_post(client, query, &vars, Duration::from_secs(8)).await {
            Ok(j) => {
                let media = &j["data"]["Media"];
                if !media.is_null() {
                    if let Some(trailer) = youtube_trailer(&media["trailer"]) {
                        return Ok(trailer);
                    }
                    push_unique_title(&mut titles, media["title"]["english"].as_str());
                    push_unique_title(&mut titles, media["title"]["romaji"].as_str());
                    year = media["startDate"]["year"].as_i64().filter(|y| *y > 0);
                    // Anything that isn't a movie is a series for TMDB's
                    // TV/movie split (TV, OVA, ONA, specials).
                    prefer_tv = media["format"].as_str() != Some("MOVIE");
                }
            }
            Err(e) => lookup_err = Some(e),
        }
    }

    // Titles supplied by the caller (e.g. Kitsu-only entries) are a last
    // resort when AniList has no record to read a title from.
    push_unique_title(&mut titles, title);

    if let Some(trailer) = tmdb::trailer_by_title(client, &titles, year, prefer_tv).await {
        return Ok(trailer);
    }

    match lookup_err {
        Some(e) => Err(e),
        None => Ok(Value::Null),
    }
}

fn score_ani_candidate(
    query: &str,
    media: &Value,
    year: Option<i64>,
    prefer_movie: bool,
) -> Option<i32> {
    let names = [
        media["title"]["english"].as_str(),
        media["title"]["romaji"].as_str(),
    ];
    let base = names
        .iter()
        .flatten()
        .map(|n| title_score::score_title(query, n))
        .max()
        .unwrap_or(0);
    if base < 700 {
        return None;
    }
    let mut score = base;
    if let (Some(want), Some(got)) = (year, media["startDate"]["year"].as_i64()) {
        let diff = (want - got).abs();
        if diff > 3 {
            return None;
        }
        score += match diff {
            0 => 150,
            1 => 80,
            _ => 0,
        };
    }
    let is_movie = media["format"].as_str() == Some("MOVIE");
    if is_movie == prefer_movie {
        score += 40;
    }
    score += (media["popularity"].as_i64().unwrap_or(0) / 10_000).min(50) as i32;
    Some(score)
}

/// Reverse fallback for the movies side: find an AniList entry by title (the
/// TMDB title/year is all we have) and return its trailer if it has one.
pub async fn trailer_by_title(
    client: &reqwest::Client,
    titles: &[String],
    year: Option<i64>,
    prefer_movie: bool,
) -> Option<Value> {
    for title in titles {
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        let j = match anilist_post(
            client,
            TRAILER_SEARCH_QUERY,
            &json!({ "search": title }),
            Duration::from_secs(8),
        )
        .await
        {
            Ok(j) => j,
            Err(_) => continue,
        };
        let media = j["data"]["Page"]["media"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut scored: Vec<(i32, Value)> = media
            .iter()
            .filter_map(|m| {
                score_ani_candidate(title, m, year, prefer_movie).map(|s| (s, m.clone()))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, m) in scored {
            if let Some(trailer) = youtube_trailer(&m["trailer"]) {
                return Some(trailer);
            }
        }
    }
    None
}

// ── Recommendations (AniList Media.recommendations) ──
pub async fn get_ani_recommendations(
    client: &reqwest::Client,
    id: Option<u64>,
    mal_id: Option<u64>,
) -> Result<Vec<Value>, String> {
    let (query, vars) = if let Some(v) = id.filter(|v| *v > 0) {
        (
            r#"query($id: Int) { Media(id: $id, type: ANIME) { recommendations { nodes { mediaRecommendation { id title { english romaji } coverImage { large } } } } } }"#.to_string(),
            json!({ "id": v }),
        )
    } else if let Some(v) = mal_id.filter(|v| *v > 0) {
        (
            r#"query($idMal: Int) { Media(idMal: $idMal, type: ANIME) { recommendations { nodes { mediaRecommendation { id title { english romaji } coverImage { large } } } } } }"#.to_string(),
            json!({ "idMal": v }),
        )
    } else {
        return Ok(vec![]);
    };
    let j = anilist_post(client, &query, &vars, Duration::from_secs(8)).await?;
    let nodes = j["data"]["Media"]["recommendations"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for node in nodes {
        let m = &node["mediaRecommendation"];
        if m.is_null() {
            continue;
        }
        let rid = m["id"].as_i64().unwrap_or(0);
        if rid == 0 || !seen.insert(rid) {
            continue;
        }
        let title = m["title"]["english"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| m["title"]["romaji"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("")
            .to_string();
        let thumbnail = m["coverImage"]["large"].as_str().unwrap_or("").to_string();
        out.push(json!({ "id": rid, "title": title, "thumbnail": thumbnail }));
        if out.len() >= 12 {
            break;
        }
    }
    Ok(out)
}

// ── Schedule (replaces jikan getAnimeSchedule) ──

const SCHEDULE_QUERY: &str = "query($idMal: Int) { Media(idMal: $idMal, type: ANIME) { status nextAiringEpisode { airingAt episode } } }";

pub async fn get_anime_schedule(client: &reqwest::Client, mal_id: &str) -> Result<Value, String> {
    let memo_key = format!("sched:{}", mal_id);
    if let Some(hit) = memo_get(&memo_key, HOUR) {
        return Ok(hit);
    }
    let default = json!({ "broadcast": "", "status": "", "nextEpisode": Value::Null });
    let id: i64 = match mal_id.parse() {
        Ok(v) => v,
        // TS Number(malId) -> NaN -> serialized null -> Media resolves nothing.
        Err(_) => return Ok(default),
    };
    let j = match anilist_post(
        client,
        SCHEDULE_QUERY,
        &json!({ "idMal": id }),
        Duration::from_secs(8),
    )
    .await
    {
        Ok(j) => j,
        Err(_) => return Ok(default),
    };
    let media = &j["data"]["Media"];
    if media.is_null() {
        return Ok(default);
    }
    let next = &media["nextAiringEpisode"];
    let out = json!({
        "broadcast": "",
        "status": media["status"].as_str().unwrap_or(""),
        "nextEpisode": if next.is_null() {
            Value::Null
        } else {
            json!({ "episode": next["episode"].as_i64().unwrap_or(0), "title": "" })
        },
    });
    memo_set(&memo_key, out.clone());
    Ok(out)
}

// ── Episode air date (feeds the "released" line on episode notifications) ──
// Only the *schedule* nodes are needed, and only when a notification is actually
// created, so this stays out of the per-poll /api/episodes path.

const EP_AIR_QUERY: &str =
    "query($idMal: Int) { Media(idMal: $idMal, type: ANIME) { airingSchedule(notYetAired: false, perPage: 50) { nodes { episode airingAt } } } }";

/// Unix seconds at which `episode` is scheduled to air, or None when AniList
/// has no schedule entry for it (un-scheduled shows, or long runners past the
/// first 50 nodes). The whole schedule is memoized per show for an hour so a
/// notification sweep costs at most one AniList call per title.
pub async fn episode_airing_at(
    client: &reqwest::Client,
    mal_id: &str,
    episode: i64,
) -> Result<Option<i64>, String> {
    let id: i64 = match mal_id.parse() {
        Ok(v) if v > 0 => v,
        _ => return Ok(None),
    };
    let memo_key = format!("airing:{id}");
    let nodes = match memo_get(&memo_key, HOUR) {
        Some(v) => v,
        None => {
            let j = anilist_post(client, EP_AIR_QUERY, &json!({ "idMal": id }), Duration::from_secs(8))
                .await?;
            let nodes = j["data"]["Media"]["airingSchedule"]["nodes"].clone();
            if !nodes.is_array() {
                return Ok(None);
            }
            memo_set(&memo_key, nodes.clone());
            nodes
        }
    };
    Ok(nodes
        .as_array()
        .into_iter()
        .flatten()
        .find(|n| n["episode"].as_i64() == Some(episode))
        .and_then(|n| n["airingAt"].as_i64())
        .filter(|at| *at > 0))
}

// ── Episode titles (replaces jikan getEpisodeTitles via Kitsu) ──

async fn mal_to_kitsu_id(client: &reqwest::Client, mal_id: &str) -> Option<String> {
    let url = format!(
        "{}?filter[externalSite]=myanimelist/anime&filter[externalId]={}",
        KITSU_MAP_URL, mal_id
    );
    let j = kitsu_get(client, &url, Duration::from_secs(8)).await.ok()?;
    j["data"][0]["relationships"]["item"]["data"]["id"]
        .as_str()
        .map(String::from)
}

// Kitsu's MAL↔Kitsu mapping table has gaps (new/airing titles return
// {"data":[]}), so MAL-id lookups come back empty for exactly the shows
// people are watching right now. Match by name instead — episode titles are
// only cosmetic, so a conservative exact/starts-with match threshold keeps a
// near-miss (sequel/special) from donating the wrong titles.
async fn kitsu_id_by_title(client: &reqwest::Client, title: &str) -> Option<String> {
    let t = title.trim();
    if t.is_empty() {
        return None;
    }
    let url = format!(
        "{}?filter[text]={}&page[limit]=10",
        KITSU_ANIME_URL,
        urlencoding::encode(t)
    );
    let j = kitsu_get(client, &url, Duration::from_secs(8)).await.ok()?;
    let data = j["data"].as_array()?;
    let mut best: Option<(i32, String)> = None;
    for d in data {
        let attrs = &d["attributes"];
        let mut candidates: Vec<&str> = Vec::new();
        for v in [
            attrs["canonicalTitle"].as_str(),
            attrs["titles"]["en"].as_str(),
            attrs["titles"]["en_jp"].as_str(),
        ] {
            if let Some(s) = v {
                candidates.push(s);
            }
        }
        if let Some(abbr) = attrs["abbreviatedTitles"].as_array() {
            for a in abbr {
                if let Some(s) = a.as_str() {
                    candidates.push(s);
                }
            }
        }
        let score = candidates
            .iter()
            .map(|c| title_score::score_title(t, c))
            .max()
            .unwrap_or(0);
        if score < 700 {
            continue;
        }
        if let Some(id) = d["id"].as_str() {
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, id.to_string()));
            }
        }
    }
    best.map(|(_, id)| id)
}

async fn kitsu_episode_titles(
    client: &reqwest::Client,
    kitsu_id: &str,
    titles: &mut Map<String, Value>,
) {
    // Parallel batches of pages: Kitsu paginates 20 eps at a time, so a
    // 1000-episode show is 50 sequential round-trips. Fetching 8 pages per
    // batch (160 eps) cuts the wall-clock time roughly 8x.
    const PAGE: usize = 20;
    const BATCH: usize = 8;
    let mut offset: usize = 0;
    while offset < 2000 {
        let mut futs = Vec::with_capacity(BATCH);
        for i in 0..BATCH {
            let o = offset + i * PAGE;
            let kitsu_id = kitsu_id.to_string();
            futs.push(async move {
                let url = format!(
                    "{}/{}/episodes?page[limit]={}&page[offset]={}&sort=number",
                    KITSU_ANIME_URL, kitsu_id, PAGE, o
                );
                kitsu_get(client, &url, Duration::from_secs(8)).await
            });
        }
        let results = futures::future::join_all(futs).await;
        let mut any_short = false;
        let mut all_empty = true;
        for r in results {
            let j = match r {
                Ok(j) => j,
                Err(_) => { any_short = true; continue; }
            };
            let data = match j["data"].as_array() {
                Some(d) => d,
                None => { any_short = true; continue; }
            };
            if data.is_empty() {
                any_short = true;
                continue;
            }
            all_empty = false;
            for ep in data {
                let attrs = &ep["attributes"];
                let name = attrs["canonicalTitle"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| attrs["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
                    .or_else(|| attrs["titles"]["en"].as_str().filter(|s| !s.is_empty()))
                    .unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let num = &attrs["number"];
                if let Some(n) = num.as_i64() {
                    titles.insert(n.to_string(), json!(name));
                } else if let Some(f) = num.as_f64() {
                    let s = if f.fract() == 0.0 {
                        format!("{}", f as i64)
                    } else {
                        format!("{}", f)
                    };
                    titles.insert(s, json!(name));
                }
            }
            if data.len() < PAGE {
                any_short = true;
            }
        }
        if all_empty || any_short {
            break;
        }
        offset += BATCH * PAGE;
    }
}

// AniList's `streamingEpisodes` carries a title per episode for some shows —
// a last-resort source for titles Kitsu and TMDB don't have.
pub async fn ani_streaming_episode_titles(
    client: &reqwest::Client,
    mal_id: &str,
    title: Option<&str>,
) -> Map<String, Value> {
    let mut out = Map::new();
    let (query, variables) = if !mal_id.is_empty() {
        (
            r#"query($idMal: Int) { Media(idMal: $idMal, type: ANIME) { streamingEpisodes { title episode } } }"#.to_string(),
            json!({ "idMal": mal_id.parse::<i64>().unwrap_or(0) }),
        )
    } else if let Some(t) = title {
        (
            r#"query($search: String) { Media(search: $search, type: ANIME) { streamingEpisodes { title episode } } }"#.to_string(),
            json!({ "search": t }),
        )
    } else {
        return out;
    };
    // Shares the memo/retry path: episode titles are requested for every show
    // page, so a separate uncached call here doubles the 429 pressure.
    let j = match anilist_post(client, &query, &variables, Duration::from_secs(8)).await {
        Ok(v) => v,
        Err(_) => return out,
    };
    let media = &j["data"]["Media"];
    if media.is_null() {
        return out;
    }
    if let Some(eps) = media["streamingEpisodes"].as_array() {
        for ep in eps {
            let num = ep["episode"].as_i64();
            let name = ep["title"].as_str().map(str::trim).filter(|s| !s.is_empty());
            if let (Some(n), Some(name)) = (num, name) {
                out.entry(n.to_string()).or_insert(json!(name));
            }
        }
    }
    out
}

pub async fn get_episode_titles(
    client: &reqwest::Client,
    mal_id: &str,
    title: Option<&str>,
) -> Result<Value, String> {
    let title = title.map(|t| t.trim()).filter(|t| !t.is_empty());
    // Mirrors Next's 1h fetch cache; empty results stay uncached so a Kitsu
    // outage isn't masked after it recovers. Keyed by both inputs so the same
    // show hit under different names doesn't collide.
    let memo_key = format!("titles:{}:{}", mal_id, title.unwrap_or(""));
    if let Some(hit) = memo_get(&memo_key, DAY_24) {
        if hit.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            return Ok(hit);
        }
    }
    let mut titles: Map<String, Value> = Map::new();

    if !mal_id.is_empty() {
        if let Some(kitsu_id) = mal_to_kitsu_id(client, mal_id).await {
            kitsu_episode_titles(client, &kitsu_id, &mut titles).await;
        }
    }

    // Fallback: match the Kitsu entry by name when the MAL mapping missed.
    // (Jikan used to sit here but has been unreachable since Oct 2026.)
    if titles.is_empty() {
        if let Some(t) = title {
            if let Some(kitsu_id) = kitsu_id_by_title(client, t).await {
                kitsu_episode_titles(client, &kitsu_id, &mut titles).await;
            }
        }
    }

    // TMDB fallback: fills gaps (and covers shows Kitsu never catalogued). Run
    // unconditionally so long-running shows (One Piece, 1000+ eps) get titles
    // for episodes beyond Kitsu's paginated window instead of only the first 500.
    if let Some(t) = title {
        if let Ok(m) = tmdb::episode_titles(client, t).await {
            if let Some(obj) = m.as_object() {
                for (k, v) in obj {
                    titles.entry(k.clone()).or_insert(v.clone());
                }
            }
        }
    }

    // AniList streamingEpisodes fallback — fills remaining gaps.
    let ani = ani_streaming_episode_titles(client, mal_id, title).await;
    for (k, v) in &ani {
        titles.entry(k.clone()).or_insert(v.clone());
    }

    let out = Value::Object(titles);
    if !out.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        memo_set(&memo_key, out.clone());
    }
    Ok(out)
}

// ── Trending & Popular (for homepage sections) ──

const TRENDING_POPULAR_QUERY: &str = "query($sort: [MediaSort]) { Page(perPage: 20) { media(sort: $sort, type: ANIME) { id idMal title { romaji english native } coverImage { large } trending popularity averageScore description status genres } } }";

fn score_of(v: &Value) -> Value {
    match v.as_f64() {
        Some(x) => json!(x.round() / 10.0),
        None => Value::Null,
    }
}

fn map_ani_media(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert(
        "malId".into(),
        json!(m["idMal"]
            .as_i64()
            .filter(|v| *v != 0)
            .map(|v| v.to_string())
            .unwrap_or_default()),
    );
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert("score".into(), score_of(&m["averageScore"]));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

fn rating_score(v: &Value) -> Value {
    let s = v.as_str().unwrap_or("");
    if s.is_empty() {
        return Value::Null;
    }
    match s.parse::<f64>() {
        Ok(x) => json!(x.round() / 10.0),
        Err(_) => Value::Null,
    }
}

fn map_kitsu_media(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    let name = en
        .or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
        .or_else(|| a["canonicalTitle"].as_str())
        .unwrap_or("");
    let mut o = Map::new();
    o.insert("_id".into(), json!(format!("kitsu-{}", d["id"].as_str().unwrap_or(""))));
    o.insert("name".into(), json!(name));
    if let Some(en) = en {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(a["posterImage"]["large"]
            .as_str()
            .or_else(|| a["posterImage"]["original"].as_str())
            .unwrap_or("")),
    );
    o.insert("score".into(), rating_score(&a["averageRating"]));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

async fn kitsu_media(
    client: &reqwest::Client,
    sort: &str,
    timeout: Duration,
) -> Result<Vec<Value>, String> {
    let url = format!("{}?page[limit]=20&sort={}", KITSU_ANIME_URL, sort);
    let j = kitsu_get(client, &url, timeout).await?;
    let data = j["data"].as_array().cloned().unwrap_or_default();
    Ok(data.iter().map(map_kitsu_media).collect())
}

async fn ani_trending_popular(client: &reqwest::Client, sort: &str) -> Result<Vec<Value>, String> {
    let j = anilist_post(
        client,
        TRENDING_POPULAR_QUERY,
        &json!({ "sort": [sort] }),
        Duration::from_secs(8),
    )
    .await?;
    let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
    Ok(media.iter().map(map_ani_media).collect())
}

pub async fn get_ani_trending(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:trending", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match ani_trending_popular(client, "TRENDING_DESC").await {
        Ok(out) => {
            memo_set("ani:trending", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => kitsu_media(client, "-favoritesCount", Duration::from_secs(8)).await,
    }
}

pub async fn get_ani_popular(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:popular", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match ani_trending_popular(client, "POPULARITY_DESC").await {
        Ok(out) => {
            memo_set("ani:popular", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => kitsu_media(client, "-userCount", Duration::from_secs(8)).await,
    }
}

const TOP_RATED_QUERY: &str = "query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false) { id idMal title { romaji english } coverImage { large } averageScore genres } } }";

fn top_row(a: &Value) -> Value {
    json!({
        "_id": a["id"].as_i64().unwrap_or(0).to_string(),
        "malId": a["idMal"].as_i64().filter(|v| *v != 0).map(|v| v.to_string()).unwrap_or_default(),
        "title": a["title"]["romaji"].as_str().unwrap_or(""),
        "englishName": a["title"]["english"].as_str().unwrap_or(""),
        "thumbnail": a["coverImage"]["large"].as_str().unwrap_or(""),
        "score": score_of(&a["averageScore"]),
        "genres": a["genres"].as_array().cloned().unwrap_or_default(),
    })
}

fn top_kitsu_row(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    json!({
        // kitsu- prefix: without it the fallback ids route as AniList ids.
        "_id": format!("kitsu-{}", d["id"].as_str().unwrap_or("")),
        "malId": "",
        "title": en.or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| a["canonicalTitle"].as_str()).unwrap_or(""),
        "englishName": a["titles"]["en"].as_str().unwrap_or(""),
        "thumbnail": a["posterImage"]["large"].as_str()
            .or_else(|| a["posterImage"]["original"].as_str()).unwrap_or(""),
        "score": rating_score(&a["averageRating"]),
        "genres": [],
    })
}

pub async fn get_ani_top_rated(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:top", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, TOP_RATED_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media.iter().map(top_row).collect();
            memo_set("ani:top", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => {
            let url = format!("{}?page[limit]=20&sort=ratingRank", KITSU_ANIME_URL);
            let j = kitsu_get(client, &url, Duration::from_secs(8)).await?;
            let data = j["data"].as_array().cloned().unwrap_or_default();
            Ok(data.iter().map(top_kitsu_row).collect())
        }
    }
}

// ── Hidden gems: highly rated but not widely watched (feeds /api/random) ──

const HIDDEN_GEMS_QUERY: &str = "query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false, averageScore_greater: 75, popularity_lesser: 60000) { id idMal title { romaji english } coverImage { large } averageScore genres } } }";

pub async fn get_ani_hidden_gems(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:gems", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, HIDDEN_GEMS_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media
                .iter()
                .map(|a| {
                    json!({
                        "_id": a["id"].as_i64().unwrap_or(0).to_string(),
                        "malId": a["idMal"].as_i64().filter(|v| *v != 0)
                            .map(|v| v.to_string()).unwrap_or_default(),
                        "score": score_of(&a["averageScore"]),
                    })
                })
                .collect();
            memo_set("ani:gems", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => Ok(vec![]),
    }
}

// ── Spotlight (ongoing/new anime with descriptions) ──

const SPOTLIGHT_QUERY: &str = "query { Page(page: 1, perPage: 10) { media(status: RELEASING, type: ANIME, isAdult: false, countryOfOrigin: \"JP\", sort: UPDATED_AT_DESC) { id idMal title { romaji english native } coverImage { large } trending popularity averageScore description status genres } } }";

fn spotlight_row(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert(
        "malId".into(),
        json!(m["idMal"]
            .as_i64()
            .filter(|v| *v != 0)
            .map(|v| v.to_string())
            .unwrap_or_default()),
    );
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert(
        "description".into(),
        json!(strip_html(m["description"].as_str().unwrap_or(""))),
    );
    o.insert(
        "genres".into(),
        json!(m["genres"].as_array().cloned().unwrap_or_default()),
    );
    o.insert("status".into(), json!(m["status"].as_str().unwrap_or("")));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

fn kitsu_spotlight_row(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(format!("kitsu-{}", d["id"].as_str().unwrap_or(""))));
    o.insert(
        "name".into(),
        json!(en.or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| a["canonicalTitle"].as_str())
            .unwrap_or("")),
    );
    if let Some(en) = en {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(a["posterImage"]["large"]
            .as_str()
            .or_else(|| a["posterImage"]["original"].as_str())
            .unwrap_or("")),
    );
    o.insert(
        "description".into(),
        json!(strip_html(a["synopsis"].as_str().unwrap_or(""))),
    );
    o.insert("genres".into(), json!([]));
    o.insert("status".into(), json!("RELEASING"));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

pub async fn get_ani_spotlight(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:spotlight:v3", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, SPOTLIGHT_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media.iter().map(spotlight_row).collect();
            memo_set("ani:spotlight:v3", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => {
            // AniList down — use Kitsu ongoing anime.
            let url = format!(
                "{}?filter[status]=current&page[limit]=10&sort=-favoritesCount",
                KITSU_ANIME_URL
            );
            match kitsu_get(client, &url, Duration::from_secs(8)).await {
                Ok(j) => {
                    let data = j["data"].as_array().cloned().unwrap_or_default();
                    Ok(data.iter().map(kitsu_spotlight_row).collect())
                }
                Err(_) => Ok(vec![]),
            }
        }
    }
}

// ── Weekly airing window (feeds /api/schedule) ──

const AIRING_QUERY: &str = "query ($start: Int, $end: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) { airingAt media { idMal title { romaji english } coverImage { large } averageScore genres } } } }";

pub async fn fetch_airing_schedules(
    client: &reqwest::Client,
    start: i64,
    end: i64,
) -> Result<Vec<Value>, String> {
    let mut all: Vec<Value> = Vec::new();
    let mut page: i64 = 1;
    let mut has_next = true;
    while has_next && page <= 10 {
        let j = anilist_post(
            client,
            AIRING_QUERY,
            &json!({ "start": start, "end": end, "page": page }),
            Duration::from_secs(10),
        )
        .await?;
        if let Some(arr) = j["data"]["Page"]["airingSchedules"].as_array() {
            all.extend(arr.iter().cloned());
        }
        has_next = j["data"]["Page"]["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false);
        page += 1;
    }
    Ok(all)
}

/// Currently airing Kitsu anime (raw `data` rows) for the schedule fallback.
pub async fn fetch_kitsu_current(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    let url = format!("{}?filter[status]=current&page[limit]=20&sort=-favoritesCount", KITSU_ANIME_URL);
    let j = kitsu_get(client, &url, Duration::from_secs(10)).await?;
    Ok(j["data"].as_array().cloned().unwrap_or_default())
}
