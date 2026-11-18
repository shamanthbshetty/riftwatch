use axum::{extract::{Query, State}, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::AppState;
use crate::anilist::anilist_post;

#[derive(Deserialize)]
pub struct Q { pub id: Option<String>, pub title: Option<String> }

#[derive(Serialize, Clone, Default)]
struct ShowDetail {
    #[serde(rename = "_id")]
    id: String,
    name: String,
    #[serde(rename = "englishName", skip_serializing_if = "Option::is_none")]
    english_name: Option<String>,
    thumbnail: String,
    description: String,
    status: String,
    score: f64,
    #[serde(rename = "malId")]
    mal_id: String,
    genres: Vec<String>,
    tags: Vec<String>,
    #[serde(rename = "availableEpisodes")]
    available_episodes: Avail,
    #[serde(rename = "availableEpisodesDetail")]
    available_episodes_detail: AvailDetail,
}

#[derive(Serialize, Clone, Default)]
struct Avail { sub: i64, dub: i64 }
#[derive(Serialize, Clone, Default)]
struct AvailDetail { sub: Vec<String>, dub: Vec<String> }

fn env_str(name: &str, def: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| def.to_string())
}

fn get_api_bases() -> Vec<String> {
    let backend = env_str("ALLANIME_BACKEND", "mkissa.net");
    let mut bases = vec![format!("https://api.{}", backend.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))];
    let raw = std::env::var("ALLANIME_FALLBACK_MIRRORS").unwrap_or_default();
    for entry in raw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let half = if entry.contains('|') { entry.split('|').nth(1).unwrap_or(entry).trim() } else { entry };
        if half.is_empty() { continue; }
        let base = if half.starts_with("http://") || half.starts_with("https://") {
            half.trim_end_matches('/').to_string()
        } else if half.starts_with("api.") {
            format!("https://{}", half.trim_end_matches('/'))
        } else {
            format!("https://api.{}", half.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))
        };
        if !bases.contains(&base) { bases.push(base); }
    }
    bases
}

fn get_referer() -> String {
    let mirror = env_str("ALLANIME_MIRROR", "mkissa.to");
    let m = mirror.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    format!("https://{}", if m.is_empty() { "mkissa.to" } else { m })
}

fn apply_proxy(target: &str) -> String {
    let proxy = env_str("ALLANIME_PROXY", "");
    if proxy.is_empty() { return target.to_string(); }
    if proxy.contains("$URL") { return proxy.replace("$URL", &urlencoding::encode(target)); }
    if proxy.contains('@') { return target.to_string(); }
    format!("{}/{}", proxy.trim_end_matches('/'), target)
}

async fn gql(client: &reqwest::Client, query: &str, variables: Value) -> Result<Value, String> {
    let bases = get_api_bases();
    let referer = get_referer();
    let mut last: Option<String> = None;
    for base in bases {
        let url = apply_proxy(&format!("{}/api", base));
        let body = json!({ "query": query, "variables": variables });
        match client.post(&url)
            .header("Content-Type", "application/json")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header("Referer", &referer)
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send().await {
            Ok(res) => {
                if !res.status().is_success() { last = Some(format!("Allanime {}", res.status())); continue; }
                if let Ok(j) = res.json::<Value>().await {
                    if let Some(errs) = j.get("errors").and_then(|e| e.as_array()) {
                        if !errs.is_empty() {
                            last = Some(errs.iter().filter_map(|e| e.get("message").and_then(|m| m.as_str())).collect::<Vec<_>>().join(", "));
                            continue;
                        }
                    }
                    if let Some(data) = j.get("data") { return Ok(data.clone()); }
                }
            }
            Err(e) => { last = Some(e.to_string()); }
        }
    }
    Err(last.unwrap_or_else(|| "Allanime unreachable".into()))
}

// NOTE: `show` takes `_id` (not `showId`), and `availableEpisodesDetail` is a
// scalar Object on this API — a sub-selection `{ sub dub }` is a GraphQL
// validation error that fails the whole query.
const SHOW_GQL: &str = r#"query($showId: String!) {
  show(_id: $showId) {
    _id name englishName thumbnail description status
    availableEpisodesDetail
  }
}"#;

const SEARCH_GQL: &str = r#"query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) {
  shows(search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin) {
    edges { _id name englishName nativeName thumbnail availableEpisodes __typename }
  }
}"#;

async fn search_anime(client: &reqwest::Client, query: &str) -> Vec<Value> {
    let input = json!({ "allowAdult": false, "allowUnknown": false, "query": query });
    let vars = json!({ "search": input, "limit": 20.0, "page": 1.0, "translationType": "sub", "countryOrigin": "ALL" });
    match gql(client, SEARCH_GQL, vars).await {
        Ok(data) => data.get("shows").and_then(|s| s.get("edges")).and_then(|e| e.as_array()).cloned().unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn strip_html(s: &str) -> String {
    if !s.contains('<') { return s.to_string(); }
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ => if !in_tag { out.push(c); },
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn str_vec(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn avail_detail(s: &Value) -> AvailDetail {
    let detail = s.get("availableEpisodesDetail").unwrap_or(&Value::Null);
    AvailDetail { sub: str_vec(&detail["sub"]), dub: str_vec(&detail["dub"]) }
}

/// Rebuild a ShowDetail from an AllAnime `show` node (raw _id fallback when the
/// node's own is missing).
fn show_from_allanime(s: &Value, fallback_id: &str) -> ShowDetail {
    ShowDetail {
        id: s["_id"].as_str().unwrap_or(fallback_id).to_string(),
        // Prefer the English title so abbreviated AllAnime names (e.g. "1P")
        // don't leak into the UI; fall back to the raw name when absent.
        name: s["englishName"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| s["name"].as_str())
            .unwrap_or("")
            .to_string(),
        english_name: s["englishName"].as_str().map(String::from),
        thumbnail: s["thumbnail"].as_str().unwrap_or("").to_string(),
        description: strip_html(s["description"].as_str().unwrap_or("")),
        status: s["status"].as_str().unwrap_or("").to_string(),
        score: 0.0,
        mal_id: String::new(),
        genres: vec![],
        tags: vec![],
        available_episodes: {
            let d = avail_detail(s);
            Avail { sub: d.sub.len() as i64, dub: d.dub.len() as i64 }
        },
        available_episodes_detail: avail_detail(s),
    }
}

/// Fetch a show's real episode ids by AllAnime id.
async fn avail_by_allanime_id(client: &reqwest::Client, show_id: &str) -> Option<AvailDetail> {
    let data = gql(client, SHOW_GQL, json!({ "showId": show_id })).await.ok()?;
    let s = data.get("show")?;
    if s.is_null() { return None; }
    let d = avail_detail(s);
    if d.sub.is_empty() && d.dub.is_empty() { return None; }
    Some(d)
}

/// AniList's `episodes` is null for still-airing shows, so a count-derived list
/// comes back empty even though providers already have released episodes. Ask
/// AllAnime (by title search) for the real per-episode ids first.
/// Also returns the AllAnime id so callers can publish the CANONICAL show id
/// regardless of which id namespace the request arrived in.
struct AllanimeMatch { id: String, detail: AvailDetail }

async fn avail_by_allanime_name(client: &reqwest::Client, name: &str) -> Option<AllanimeMatch> {
    if name.trim().is_empty() { return None; }
    let results = search_anime(client, name).await;
    // Identity-match the rows against the target title (exact → same base →
    // prefix) instead of a loose substring test that a spin-off could satisfy.
    let titles: Vec<String> = results
        .iter()
        .map(|r| {
            let en = r["englishName"].as_str().unwrap_or("").trim();
            if en.is_empty() { r["name"].as_str().unwrap_or("").to_string() } else { en.to_string() }
        })
        .collect();
    let gid = results.get(*crate::title_score::rank_candidates(name, &titles).first()?)?["_id"].as_str()?.to_string();
    Some(AllanimeMatch { id: gid.clone(), detail: avail_by_allanime_id(client, &gid).await? })
}

// Ok(Some) = resolved · Ok(None) = AniList definitively doesn't know the id ·
// Err = AniList could not be reached / rate-limited us, so the caller must not
// report "not found".
async fn resolve_anilist_by_id(
    client: &reqwest::Client,
    anilist_id: &str,
) -> Result<Option<ShowDetail>, String> {
    let id_num = match anilist_id.parse::<i64>() {
        Ok(n) => n,
        Err(_) => return Ok(None),
    };
    let mut upstream_err: Option<String> = None;
    for field in ["id", "idMal"] {
        let query = format!(r#"query($id: Int!) {{ Media({}: $id, type: ANIME) {{ title {{ english romaji }} idMal description coverImage {{ large }} status genres episodes }} }}"#, field);
        let j = match anilist_post(client, &query, &json!({ "id": id_num }), Duration::from_secs(8)).await {
            Ok(j) => j,
            Err(e) => {
                upstream_err = Some(e);
                continue;
            }
        };
        let media = &j["data"]["Media"];
        if media.is_null() {
            continue;
        }
        let title = &media["title"];
        let name = title["english"]
            .as_str()
            .or_else(|| title["romaji"].as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let mal_id = media["idMal"].as_i64().map(|x| x.to_string()).unwrap_or_default();
        let genres: Vec<String> = media["genres"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default();
        // Real ids from AllAnime when it has the show; AniList's episode count
        // (null on airing titles) only as a fallback.
        let ep_count = media["episodes"].as_i64().unwrap_or(0);
        let mut detail = AvailDetail {
            sub: (1..=ep_count).map(|i| i.to_string()).collect(),
            dub: (1..=ep_count).map(|i| i.to_string()).collect(),
        };
        // Canonical (AllAnime) id, so a watchlist entry written from any id
        // namespace resolves on every route.
        let mut show_id = anilist_id.to_string();
        if let Some(aa) = avail_by_allanime_name(client, &name).await {
            show_id = aa.id;
            detail = aa.detail;
        }
        return Ok(Some(ShowDetail {
            id: show_id,
            name,
            english_name: title["english"].as_str().map(String::from),
            thumbnail: media["coverImage"]["large"].as_str().unwrap_or("").to_string(),
            description: strip_html(media["description"].as_str().unwrap_or("")),
            status: media["status"].as_str().unwrap_or("").to_string(),
            score: 0.0,
            mal_id,
            genres,
            tags: vec![],
            available_episodes: Avail { sub: detail.sub.len() as i64, dub: detail.dub.len() as i64 },
            available_episodes_detail: detail,
        }));
    }
    match upstream_err {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

async fn resolve_title_fallback(client: &reqwest::Client, title: &str) -> Result<Option<ShowDetail>, String> {
    let body = json!({ "query": "query($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME) { title { english romaji } idMal description coverImage { large } status genres episodes } } }", "variables": { "search": title } });
    let j = anilist_post(
        client,
        body["query"].as_str().unwrap_or(""),
        &body["variables"],
        Duration::from_secs(8),
    )
    .await?;
    let media = &j["data"]["Page"]["media"][0];
    if media.is_null() {
        return Ok(None);
    }
    let title_name = media["title"]["english"].as_str().or_else(|| media["title"]["romaji"].as_str()).unwrap_or(title);
    let genres: Vec<String> = media["genres"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default();
    let ep_count = media["episodes"].as_i64().unwrap_or(0);
    let mut detail = AvailDetail {
        sub: (1..=ep_count).map(|i| i.to_string()).collect(),
        dub: (1..=ep_count).map(|i| i.to_string()).collect(),
    };
    let mut show_id = String::new();
    if let Some(aa) = avail_by_allanime_name(client, title_name).await {
        show_id = aa.id;
        detail = aa.detail;
    }
    Ok(Some(ShowDetail {
        id: show_id,
        name: title_name.to_string(),
        english_name: media["title"]["english"].as_str().map(String::from),
        thumbnail: media["coverImage"]["large"].as_str().unwrap_or("").to_string(),
        description: strip_html(media["description"].as_str().unwrap_or("")),
        status: media["status"].as_str().unwrap_or("").to_string(),
        score: 0.0,
        mal_id: media["idMal"].as_i64().map(|x| x.to_string()).unwrap_or_default(),
        genres,
        tags: vec![],
        available_episodes: Avail { sub: detail.sub.len() as i64, dub: detail.dub.len() as i64 },
        available_episodes_detail: detail,
    }))
}

pub async fn handler(State(state): State<AppState>, Query(q): Query<Q>) -> impl IntoResponse {
    let id = match q.id { Some(i) if !i.is_empty() => i, _ => return (StatusCode::BAD_REQUEST, Json(json!({"error":"id required"}))).into_response() };
    if !id.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-') || id.len() > 100 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response();
    }
    let title_param = q.title.clone();

    // 1. AllAnime getShow
    let mut show: Option<ShowDetail> = None;
    let mut mal_id = String::new();
    // Distinguishes "this id does not exist" (404) from "an upstream lookup
    // failed" (503, retryable) so a rate-limit blip never reads as
    // "anime not found".
    let mut upstream_error: Option<String> = None;
    match gql(&state.http, SHOW_GQL, json!({ "showId": id })).await {
        Ok(data) => {
            if let Some(s) = data.get("show") {
                if !s.is_null() {
                    show = Some(show_from_allanime(s, &id));
                }
            }
        }
        Err(e) => upstream_error = Some(e),
    }

    // 2. Kitsu
    if show.is_none() && id.starts_with("kitsu-") {
        let kitsu_id = id.trim_start_matches("kitsu-");
        if let Ok(res) = state.http.get(format!("https://kitsu.io/api/edge/anime/{}", kitsu_id))
            .header("Accept", "application/vnd.api+json")
            .timeout(Duration::from_secs(8)).send().await {
            if res.status().is_success() {
                if let Ok(j) = res.json::<Value>().await {
                    let attrs = &j["data"]["attributes"];
                    let name = attrs["titles"]["en"].as_str().or_else(|| attrs["titles"]["en_jp"].as_str()).or_else(|| attrs["canonicalTitle"].as_str()).unwrap_or("").to_string();
                    if !name.is_empty() {
                        let results = search_anime(&state.http, &name).await;
                        let good = results.iter().find(|r| {
                            let rname = r["name"].as_str().unwrap_or("");
                            rname.to_lowercase().contains(&name.to_lowercase()) || name.to_lowercase().contains(&rname.to_lowercase())
                        });
                        if let Some(g) = good {
                            if let Some(gid) = g["_id"].as_str() {
                                if let Ok(data) = gql(&state.http, SHOW_GQL, json!({ "showId": gid })).await {
                                    if let Some(s) = data.get("show") {
                                        if !s.is_null() {
                                            let mut sh = show_from_allanime(s, &id);
                                            if sh.name.is_empty() { sh.name = name.clone(); }
                                            show = Some(sh);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Numeric (AniList) id
    if show.is_none() && id.chars().all(|c| c.is_ascii_digit()) {
        match resolve_anilist_by_id(&state.http, &id).await {
            Ok(Some(s)) => show = Some(s),
            // AniList answered and the id doesn't exist — that's a real 404,
            // even if AllAnime was down for the hash lookup above.
            Ok(None) => upstream_error = None,
            Err(e) => upstream_error = Some(e),
        }
    }

    // 4. Title fallback (client cache)
    if show.is_none() {
        if let Some(t) = &title_param {
            match resolve_title_fallback(&state.http, t).await {
                Ok(Some(mut s)) => {
                    // AllAnime id when the title matched one, else the request
                    // id (the client's "not found" test requires a non-empty _id).
                    if s.id.is_empty() { s.id = id.clone(); }
                    show = Some(s);
                }
                Ok(None) => {}
                Err(e) => upstream_error = Some(e),
            }
        }
    }

    // Enrich malId from AniList if missing
    if let Some(s) = &show {
        if s.mal_id.is_empty() && !s.name.is_empty() {
            // best-effort: search AniList by name
            let query = "query($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME) { idMal } } }";
            if let Ok(j) = anilist_post(&state.http, query, &json!({ "search": s.name }), Duration::from_secs(8)).await {
                if let Some(m) = j["data"]["Page"]["media"][0]["idMal"].as_i64() {
                    mal_id = m.to_string();
                }
            }
        } else {
            mal_id = s.mal_id.clone();
        }
    }

    match show {
        Some(s) => {
            let mut out = s.clone();
            out.mal_id = if mal_id.is_empty() { s.mal_id.clone() } else { mal_id.clone() };
            (StatusCode::OK, Json(serde_json::to_value(&out).unwrap())).into_response()
        }
        None => match upstream_error {
            // We could not prove the id is wrong — say so instead of 404.
            Some(e) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": format!("Anime lookup temporarily unavailable ({e})") })),
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, Json(json!({"error":"Show not found"}))).into_response(),
        },
    }
}
