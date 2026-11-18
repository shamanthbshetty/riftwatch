// TMDB movie/TV JSON routes (ports of src/app/api/movies/**/route.ts).
// Owned by the movies migration. Response shapes must match the TS routes.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cmp::Ordering;

use crate::movie_providers::get_movie_stream;
use crate::tmdb;
use crate::AppState;

#[derive(Deserialize)]
pub struct QDetails {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub typ: Option<String>,
}

#[derive(Deserialize)]
pub struct QEpisodes {
    pub id: Option<String>,
    pub season: Option<String>,
}

#[derive(Deserialize)]
pub struct QType {
    #[serde(rename = "type")]
    pub typ: Option<String>,
}

#[derive(Deserialize)]
pub struct QRecommendations {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub typ: Option<String>,
}

#[derive(Deserialize)]
pub struct QSearch {
    pub q: Option<String>,
    pub page: Option<String>,
}

#[derive(Deserialize)]
pub struct QId {
    pub id: Option<String>,
}

#[derive(Deserialize)]
pub struct QStream {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub typ: Option<String>,
    pub season: Option<String>,
    pub episode: Option<String>,
}

/// JS `Number()` on a query-param string: "" and whitespace are 0, unparsable is NaN.
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        0.0
    } else {
        t.parse::<f64>().unwrap_or(f64::NAN)
    }
}

/// JS `String(n)` for integer-valued numbers used in URL paths.
fn js_int_str(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// TS routes answer failures with `String(e)` on an Error, i.e. "Error: <msg>".
fn upstream_err(e: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("Error: {e}") }))).into_response()
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

pub async fn details(State(state): State<AppState>, Query(q): Query<QDetails>) -> impl IntoResponse {
    let id = q.id.as_deref().map_or(0.0, js_number);
    if id == 0.0 || id.is_nan() {
        return bad_request("id required");
    }
    let is_tv = q.typ.as_deref() == Some("tv");
    let path_id = js_int_str(id);
    let (details, credits) = tokio::join!(
        tmdb::details(&state.http, is_tv, &path_id),
        tmdb::credits(&state.http, is_tv, &path_id),
    );
    let (mut details, credits) = match (details, credits) {
        (Ok(d), Ok(c)) => (d, c),
        (Err(e), _) => return upstream_err(e),
        (_, Err(e)) => return upstream_err(e),
    };
    let cast = credits
        .get("cast")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().take(10).cloned().collect::<Vec<Value>>())
        .unwrap_or_default();
    if !details.is_object() {
        details = json!({});
    }
    if let Some(obj) = details.as_object_mut() {
        obj.insert("cast".into(), Value::Array(cast));
    }
    (StatusCode::OK, Json(details)).into_response()
}

pub async fn episodes(State(state): State<AppState>, Query(q): Query<QEpisodes>) -> impl IntoResponse {
    let id = q.id.as_deref().map_or(0.0, js_number);
    let season = q.season.as_deref().map_or(0.0, js_number);
    if id == 0.0 || id.is_nan() || season == 0.0 || season.is_nan() {
        return bad_request("id and season required");
    }
    match tmdb::tv_season(&state.http, &js_int_str(id), &js_int_str(season)).await {
        Ok(data) => {
            let eps = data
                .get("episodes")
                .and_then(|e| e.as_array())
                .cloned()
                .unwrap_or_default();
            (StatusCode::OK, Json(Value::Array(eps))).into_response()
        }
        Err(e) => upstream_err(e),
    }
}

pub async fn popular(State(state): State<AppState>, Query(q): Query<QType>) -> impl IntoResponse {
    match tmdb::popular(&state.http, q.typ.as_deref().unwrap_or("movie")).await {
        Ok(data) => (StatusCode::OK, Json(data)).into_response(),
        Err(e) => upstream_err(e),
    }
}

pub async fn recommendations(
    State(state): State<AppState>,
    Query(q): Query<QRecommendations>,
) -> impl IntoResponse {
    let id_raw = q.id.as_deref().unwrap_or("");
    if id_raw.is_empty() || !id_raw.bytes().all(|b| b.is_ascii_digit()) {
        return bad_request("numeric id required");
    }
    let typ = if q.typ.as_deref() == Some("tv") { "tv" } else { "movie" };
    let id = js_int_str(js_number(id_raw));
    match tmdb::recommendations(&state.http, typ, &id).await {
        Ok(results) => (StatusCode::OK, Json(json!({ "results": results }))).into_response(),
        Err(e) => upstream_err(e),
    }
}

pub async fn videos(State(state): State<AppState>, Query(q): Query<QDetails>) -> impl IntoResponse {
    let id = q.id.as_deref().map_or(0.0, js_number);
    if id == 0.0 || id.is_nan() {
        return bad_request("id required");
    }
    let is_tv = q.typ.as_deref() == Some("tv");
    let path_id = js_int_str(id);
    match tmdb::videos(&state.http, is_tv, &path_id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => upstream_err(e),
    }
}

pub async fn search(State(state): State<AppState>, Query(q): Query<QSearch>) -> impl IntoResponse {
    let query = match q.q {
        Some(s) if !s.is_empty() => s,
        _ => return bad_request("q required"),
    };
    let page = js_int_str(q.page.as_deref().map_or(1.0, js_number));
    let mut data = match tmdb::search(&state.http, &query, &page).await {
        Ok(d) => d,
        Err(e) => return upstream_err(e),
    };
    let ql = query.to_lowercase();
    let mut items: Vec<Value> = data
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| matches!(r["media_type"].as_str(), Some("movie") | Some("tv")))
        .collect();
    items.sort_by(|a, b| rank_cmp(&title_of(a), &title_of(b), &ql));
    if !data.is_object() {
        data = json!({});
    }
    if let Some(obj) = data.as_object_mut() {
        obj.insert("results".into(), Value::Array(items));
    }
    (StatusCode::OK, Json(data)).into_response()
}

pub async fn top_rated(State(state): State<AppState>) -> impl IntoResponse {
    let (movies, tv) = tokio::join!(
        tmdb::top_rated(&state.http, "movie"),
        tmdb::top_rated(&state.http, "tv"),
    );
    match (movies, tv) {
        (Ok(movies), Ok(tv)) => {
            (StatusCode::OK, Json(json!({ "movies": movies, "tv": tv }))).into_response()
        }
        (Err(e), _) => upstream_err(e),
        (_, Err(e)) => upstream_err(e),
    }
}

pub async fn trending(State(state): State<AppState>) -> impl IntoResponse {
    let (movies, tv) = tokio::join!(tmdb::trending(&state.http), tmdb::trending_tv(&state.http));
    match (movies, tv) {
        (Ok(movies), Ok(tv)) => {
            (StatusCode::OK, Json(json!({ "movies": movies, "tv": tv }))).into_response()
        }
        (Err(e), _) => upstream_err(e),
        (_, Err(e)) => upstream_err(e),
    }
}

pub async fn tv_episodes(State(state): State<AppState>, Query(q): Query<QId>) -> impl IntoResponse {
    let id = q.id.as_deref().map_or(0.0, js_number);
    if id == 0.0 || id.is_nan() {
        return bad_request("id required");
    }
    match tmdb::tv_total_episodes(&state.http, &js_int_str(id)).await {
        Ok(total) => (StatusCode::OK, Json(json!({ "total": total }))).into_response(),
        Err(e) => upstream_err(e),
    }
}

pub async fn stream(State(state): State<AppState>, Query(q): Query<QStream>) -> impl IntoResponse {
    let id = q.id.as_deref().map_or(0.0, js_number);
    if !id.is_finite() || id.fract() != 0.0 || id <= 0.0 {
        return bad_request("invalid params");
    }
    let is_tv = q.typ.as_deref() == Some("tv");
    let season = q.season.as_deref().filter(|s| !s.is_empty()).map(js_number);
    let episode = q.episode.as_deref().filter(|s| !s.is_empty()).map(js_number);
    let is_int = |v: f64| v.is_finite() && v.fract() == 0.0;
    if is_tv {
        match (season, episode) {
            (Some(s), Some(e)) if is_int(s) && is_int(e) && s >= 1.0 && e >= 1.0 => {}
            _ => return bad_request("invalid params"),
        }
    } else if season.map_or(false, |v| !is_int(v)) || episode.map_or(false, |v| !is_int(v)) {
        return bad_request("invalid params");
    }

    let typ = if is_tv { "tv" } else { "movie" };
    let path_id = js_int_str(id);
    // Best-effort title/poster — not found just means fallback values.
    let mut title = String::new();
    let mut poster = Value::Null;
    if let Ok(d) = tmdb::details(&state.http, is_tv, &path_id).await {
        title = d["title"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| d["name"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("")
            .to_string();
        poster = d["poster_path"].clone();
    }

    match get_movie_stream(
        &state.http,
        id as u32,
        typ,
        season.map(|v| v as i64),
        episode.map(|v| v as i64),
    )
    .await
    {
        Ok(stream) => {
            let sources = stream
                .get("sources")
                .and_then(|s| s.as_array())
                .cloned()
                .unwrap_or_default();
            if sources.is_empty() {
                return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "no sources found" })))
                    .into_response();
            }
            let subtitles = stream
                .get("subtitles")
                .and_then(|s| s.as_array())
                .cloned()
                .unwrap_or_default();
            (StatusCode::OK, Json(json!({
                "title": title,
                "poster": poster,
                "sources": sources,
                "subtitles": subtitles,
            })))
            .into_response()
        }
        Err(e) => upstream_err(e),
    }
}

fn title_of(r: &Value) -> String {
    r["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| r["name"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_lowercase()
}

/// Exact-title match first, then prefix match, then shorter title wins.
fn rank_cmp(a: &str, b: &str, ql: &str) -> Ordering {
    let (a_exact, b_exact) = (a == ql, b == ql);
    if a_exact != b_exact {
        return if a_exact { Ordering::Less } else { Ordering::Greater };
    }
    let (a_starts, b_starts) = (a.starts_with(ql), b.starts_with(ql));
    if a_starts != b_starts {
        return if a_starts { Ordering::Less } else { Ordering::Greater };
    }
    if a_starts {
        return a.chars().count().cmp(&b.chars().count());
    }
    Ordering::Equal
}
