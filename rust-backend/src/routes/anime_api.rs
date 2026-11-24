// Anime discovery JSON routes (ports of src/app/api/{health,jikan-anime,
// relations,titles,schedule,search,spotlight,trending,popular,top-rated,
// random}/route.ts). Owned by the anime migration. Shapes must match TS.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::{Datelike, FixedOffset, SecondsFormat, Timelike, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::allanime_client;
use crate::anilist;
use crate::config;
use crate::title_score;
use crate::tmdb;
use crate::AppState;

const DAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

// JST = UTC+9 fixed — component formatTimeJST expects it regardless of host TZ.
static JST: LazyLock<FixedOffset> = LazyLock::new(|| FixedOffset::east_opt(9 * 3600).unwrap());

// TS String(e) on an Error yields "Error: <message>".
fn err_502(msg: &str) -> axum::response::Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": format!("Error: {}", msg) })),
    )
        .into_response()
}

// ── /api/health ──

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

struct Probe {
    ok: bool,
    status: Value,
    latency_ms: u64,
}

async fn probe(client: &reqwest::Client, url: &str) -> Probe {
    let start = Instant::now();
    match client
        .get(url)
        .header("User-Agent", CHROME_UA)
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        // Any HTTP response (even 404/403) proves DNS + TCP + TLS work — only
        // 5xx / network throws count as down.
        Ok(res) => Probe {
            ok: res.status().as_u16() < 500,
            status: json!(res.status().as_u16()),
            latency_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => Probe {
            ok: false,
            status: json!(e.to_string().chars().take(80).collect::<String>()),
            latency_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn probe_group(
    client: &reqwest::Client,
    bases: &[String],
    suffix: &str,
) -> Vec<(String, Probe)> {
    let futs = bases.iter().map(|b| {
        let url = format!("{}{}", b, suffix);
        async move { (b.clone(), probe(client, &url).await) }
    });
    futures::future::join_all(futs).await
}

fn probe_obj(probes: Vec<(String, Probe)>) -> Value {
    let mut m = Map::new();
    for (k, p) in probes {
        m.insert(
            k,
            json!({ "ok": p.ok, "status": p.status, "latencyMs": p.latency_ms }),
        );
    }
    Value::Object(m)
}

fn any_down(probes: &[(String, Probe)]) -> bool {
    probes.iter().all(|(_, p)| !p.ok)
}

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let aniwatch_bases = config::env_list("ANIWATCH_BASES", &["https://aniwatch.co.at"]);
    let anikoto_raw = config::env_list(
        "ANIKOTO_MIRRORS",
        &[
            "https://anikoto.cz",
            "https://anikototv.to",
            "https://anikoto.me",
            "https://anikoto.net",
        ],
    );
    let anikoto_hosts: Vec<String> = anikoto_raw
        .iter()
        .filter_map(|e| e.split('|').next())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .collect();
    let kb_default = config::env_str("KENJITSU_BASE", "https://kenjitsu.vercel.app");
    let kenjitsu_bases = config::env_list("KENJITSU_BASES", &[kb_default.as_str()]);
    let backend = config::env_str("ALLANIME_BACKEND", "mkissa.net");
    let backend = backend
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let allanime_url = format!("https://api.{}/api", backend);
    let vidsrc_domains = config::env_list(
        "VIDSRC_DOMAINS",
        &[
            "https://vidsrc.sh",
            "https://vidsrc2.ru",
            "https://vidsrc.ir",
            "https://vsembed.su",
        ],
    );

    let (aniwatch, anikoto, kenjitsu, allanime, vidsrc) = tokio::join!(
        probe_group(&state.http_safe, &aniwatch_bases, "/"),
        probe_group(&state.http_safe, &anikoto_hosts, "/"),
        probe_group(
            &state.http_safe,
            &kenjitsu_bases,
            "/api/anizone/anime/search?q=naruto"
        ),
        probe(&state.http_safe, &allanime_url),
        probe_group(&state.http_safe, &vidsrc_domains, "/"),
    );

    let ok = !any_down(&aniwatch) || !any_down(&anikoto) || !any_down(&kenjitsu);
    Json(json!({
        "ok": ok,
        "ts": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "upstreams": {
            "aniwatch": probe_obj(aniwatch),
            "anikoto": probe_obj(anikoto),
            "kenjitsu": probe_obj(kenjitsu),
            "allanime": json!({ "ok": allanime.ok, "status": allanime.status, "latencyMs": allanime.latency_ms }),
            "vidsrc": probe_obj(vidsrc),
        },
        "hint": "A group counts as down only when EVERY domain in it fails. If one domain is down, override via ANIWATCH_BASES / ANIKOTO_MIRRORS / KENJITSU_BASES / ALLANIME_BACKEND / VIDSRC_DOMAINS (see .env.example) and restart.",
    }))
}

// ── /api/jikan-anime ──

#[derive(Deserialize)]
pub struct MalQ {
    #[serde(rename = "malId")]
    pub mal_id: Option<String>,
}

pub async fn jikan_anime(State(state): State<AppState>, Query(q): Query<MalQ>) -> impl IntoResponse {
    let mal_id = match q.mal_id {
        Some(v) if !v.is_empty() => v,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "malId required" })),
            )
                .into_response()
        }
    };
    match anilist::get_anime_schedule(&state.http, &mal_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/anime/ep-date ──
#[derive(Deserialize)]
pub struct EpDateQ {
    #[serde(rename = "malId")]
    pub mal_id: Option<String>,
    pub ep: Option<String>,
}

/// `{ "airDate": "2026-11-14" }` — the UTC calendar date an episode airs, or
/// `{}` when AniList has no schedule for it. Called only when a notification
/// is created; never on the poll itself, so it cannot burn the rate limit.
pub async fn ep_date(State(state): State<AppState>, Query(q): Query<EpDateQ>) -> impl IntoResponse {
    let mal_id = q.mal_id.unwrap_or_default();
    let ep: i64 = q.ep.as_deref().and_then(|v| v.parse().ok()).unwrap_or(0);
    if mal_id.trim().is_empty() || ep <= 0 {
        return Json(json!({})).into_response();
    }
    match anilist::episode_airing_at(&state.http, mal_id.trim(), ep).await {
        Ok(Some(ts)) => {
            let date = Utc
                .timestamp_opt(ts, 0)
                .single()
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            if date.is_empty() {
                Json(json!({})).into_response()
            } else {
                Json(json!({ "airDate": date })).into_response()
            }
        }
        Ok(None) | Err(_) => Json(json!({})).into_response(),
    }
}

// ── /api/relations ──

#[derive(Deserialize)]
pub struct RelQ {
    pub id: Option<String>,
    #[serde(rename = "malId")]
    pub mal_id: Option<String>,
}

// /^\d+$/ then Number() — matches the TS route's id parsing.
fn parse_id(s: &Option<String>) -> Option<u64> {
    s.as_deref()
        .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        .and_then(|v| v.parse().ok())
}

pub async fn relations(State(state): State<AppState>, Query(q): Query<RelQ>) -> impl IntoResponse {
    let id = parse_id(&q.id);
    let mal_id = parse_id(&q.mal_id);
    let provided = |v: Option<u64>| matches!(v, Some(x) if x > 0);
    if !provided(id) && !provided(mal_id) {
        return Json(json!({ "relations": [] })).into_response();
    }
    let rels = anilist::get_ani_relations(&state.http, id, mal_id)
        .await
        .unwrap_or_default();
    Json(json!({ "relations": rels })).into_response()
}

// ── /api/anime/trailer ──
#[derive(Deserialize)]
pub struct TrailerQ {
    pub id: Option<String>,
    #[serde(rename = "malId")]
    pub mal_id: Option<String>,
    pub title: Option<String>,
}

pub async fn trailer(State(state): State<AppState>, Query(q): Query<TrailerQ>) -> impl IntoResponse {
    let id = parse_id(&q.id);
    let mal_id = parse_id(&q.mal_id);
    let title = q.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    match anilist::get_ani_trailer(&state.http, id, mal_id, title).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Error: {e}") })),
        )
            .into_response(),
    }
}

// ── /api/anime/recommendations ──
pub async fn recommendations(State(state): State<AppState>, Query(q): Query<RelQ>) -> impl IntoResponse {
    let id = parse_id(&q.id);
    let mal_id = parse_id(&q.mal_id);
    match anilist::get_ani_recommendations(&state.http, id, mal_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Error: {e}") })),
        )
            .into_response(),
    }
}

// ── /api/titles ──

#[derive(Deserialize)]
pub struct TitlesQ {
    #[serde(rename = "malId")]
    pub mal_id: Option<String>,
    pub title: Option<String>,
}

pub async fn titles(State(state): State<AppState>, Query(q): Query<TitlesQ>) -> impl IntoResponse {
    let mal_id = q.mal_id.as_deref().filter(|v| !v.is_empty());
    let title = q.title.as_deref().filter(|v| !v.is_empty());
    if mal_id.is_none() && title.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malId or title required" })),
        )
            .into_response();
    }
    match anilist::get_episode_titles(&state.http, mal_id.unwrap_or(""), title).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/schedule ──

#[derive(Deserialize)]
pub struct SchedQ {
    pub page: Option<String>,
}

// The complete AniList weekly window, cached 30 min.
static SCHEDULE_CACHE: LazyLock<Mutex<Option<(Instant, Vec<Value>)>>> =
    LazyLock::new(|| Mutex::new(None));

fn format_jst(ts: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
        .with_timezone(&*JST);
    format!("{:02}:{:02}", dt.hour(), dt.minute())
}

// UTC day-of-week, mon..sun — same indexing as TS DAYS[getUTCDay()…].
fn day_index(ts: i64) -> usize {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.weekday().num_days_from_monday() as usize)
        .unwrap_or(0)
}

fn score_or_null(v: &Value) -> Value {
    match v.as_f64() {
        Some(x) => json!(x.round() / 10.0),
        None => Value::Null,
    }
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

fn sort_entries(entries: &mut [Value]) {
    entries.sort_by(|a, b| {
        let sa = a["score"].as_f64().unwrap_or(0.0);
        let sb = b["score"].as_f64().unwrap_or(0.0);
        sb.partial_cmp(&sa)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn empty_days() -> Value {
    let mut m = Map::new();
    for d in DAYS {
        m.insert(d.to_string(), json!({ "entries": [], "hasMore": false }));
    }
    Value::Object(m)
}

async fn kitsu_schedule(client: &reqwest::Client) -> Result<Value, String> {
    let data = anilist::fetch_kitsu_current(client).await?;
    let mut grouped: Vec<Vec<Value>> = vec![Vec::new(); 7];
    for d in &data {
        let a = &d["attributes"];
        let nr = match a["nextRelease"].as_str() {
            Some(s) => s,
            None => continue,
        };
        let dt = match chrono::DateTime::parse_from_rfc3339(nr) {
            Ok(v) => v.with_timezone(&Utc),
            Err(_) => continue,
        };
        let title = a["titles"]["en"]
            .as_str()
            .filter(|t| !t.is_empty())
            .or_else(|| a["titles"]["en_jp"].as_str().filter(|t| !t.is_empty()))
            .or_else(|| a["canonicalTitle"].as_str())
            .unwrap_or("");
        let entry = json!({
            "title": title,
            "time": format_jst(dt.timestamp()),
            "malId": 0,
            "thumbnail": a["posterImage"]["large"].as_str()
                .or_else(|| a["posterImage"]["original"].as_str())
                .unwrap_or(""),
            "score": rating_score(&a["averageRating"]),
            "genres": [],
        });
        grouped[dt.weekday().num_days_from_monday() as usize].push(entry);
    }
    let mut result = Map::new();
    for (i, day) in DAYS.iter().enumerate() {
        let mut entries = std::mem::take(&mut grouped[i]);
        sort_entries(&mut entries);
        result.insert(
            day.to_string(),
            json!({ "entries": entries, "hasMore": false }),
        );
    }
    Ok(Value::Object(result))
}

pub async fn schedule(State(state): State<AppState>, Query(q): Query<SchedQ>) -> impl IntoResponse {
    // Number("abc") is NaN → page 1 for anything malformed.
    let page = q
        .page
        .as_deref()
        .unwrap_or("1")
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 1.0)
        .map(|v| v.floor() as u64)
        .unwrap_or(1);

    let cached: Option<Vec<Value>> = {
        let guard = SCHEDULE_CACHE.lock().unwrap();
        guard
            .as_ref()
            .filter(|(ts, _)| ts.elapsed() < Duration::from_secs(30 * 60))
            .map(|(_, v)| v.clone())
    };

    let schedules = match cached {
        Some(s) => s,
        None => {
            let now = Utc::now().timestamp();
            match anilist::fetch_airing_schedules(&state.http, now - 4 * 86400, now + 4 * 86400)
                .await
            {
                Ok(s) => {
                    *SCHEDULE_CACHE.lock().unwrap() = Some((Instant::now(), s.clone()));
                    s
                }
                // AniList down — Kitsu currently airing, then empty days.
                Err(_) => {
                    return Json(kitsu_schedule(&state.http).await.unwrap_or_else(|_| empty_days()))
                        .into_response()
                }
            }
        }
    };

    let mut grouped: Vec<Vec<Value>> = vec![Vec::new(); 7];
    for s in &schedules {
        let ts = s["airingAt"].as_i64().unwrap_or(0);
        let media = &s["media"];
        let title = media["title"]["english"]
            .as_str()
            .filter(|t| !t.is_empty())
            .or_else(|| media["title"]["romaji"].as_str())
            .unwrap_or("");
        let entry = json!({
            "title": title,
            "time": format_jst(ts),
            "malId": media["idMal"].as_i64().unwrap_or(0),
            "thumbnail": media["coverImage"]["large"].as_str().unwrap_or(""),
            "score": score_or_null(&media["averageScore"]),
            "genres": media["genres"].as_array().cloned().unwrap_or_default(),
        });
        grouped[day_index(ts)].push(entry);
    }

    // Cap pagination: 10 pages x 15 = 150 entries per day is far beyond any
    // real day, and unbounded page values were only ever an abuse vector.
    let limit = page.saturating_mul(15).min(150) as usize;
    let mut result = Map::new();
    for (i, day) in DAYS.iter().enumerate() {
        let mut entries = std::mem::take(&mut grouped[i]);
        sort_entries(&mut entries);
        let total = entries.len();
        entries.truncate(limit);
        result.insert(
            day.to_string(),
            json!({ "entries": entries, "hasMore": total > limit }),
        );
    }
    Json(Value::Object(result)).into_response()
}

// ── /api/search ──

#[derive(Deserialize)]
pub struct SearchQ {
    pub q: Option<String>,
}

pub async fn search(State(state): State<AppState>, Query(q): Query<SearchQ>) -> impl IntoResponse {
    let q = match q.q {
        Some(v) if !v.is_empty() => v,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "q required" })),
            )
                .into_response()
        }
    };

    // allanime first (its rows carry episodes); AniList fills the gaps —
    // upcoming shows and finished titles allanime never catalogued.
    let (aa, al) = tokio::join!(
        allanime_client::search_anime(&q),
        anilist::search_ani_list(&state.http, &q),
    );
    if aa.is_err() && al.is_err() {
        return err_502(&aa.unwrap_err());
    }
    // Listings only show what's released — NOT_YET_RELEASED rows are dropped
    // here; the Schedule section is where upcoming titles still appear.
    let not_released = |r: &Value| r["status"].as_str() == Some("NOT_YET_RELEASED");
    let base: Vec<Value> = match &aa {
        Ok(v) => v
            .iter()
            .filter(|r| !not_released(r))
            .cloned()
            .collect(),
        Err(_) => Vec::new(),
    };
    let extra: Vec<Value> = match &al {
        Ok(v) => v
            .iter()
            .filter(|r| !not_released(r))
            .cloned()
            .collect(),
        Err(_) => Vec::new(),
    };

    let mut seen: HashSet<String> = HashSet::new();
    for b in &base {
        seen.insert(title_score::normalize(b["name"].as_str().unwrap_or("")));
        if let Some(en) = b["englishName"].as_str().filter(|s| !s.is_empty()) {
            seen.insert(title_score::normalize(en));
        }
    }

    let mut merged = base.clone();
    for e in &extra {
        let n = title_score::normalize(e["name"].as_str().unwrap_or(""));
        if seen.contains(&n) {
            continue;
        }
        // starts-with-level match against any allanime row = same show
        if base.iter().any(|b| {
            title_score::score_title(
                e["name"].as_str().unwrap_or(""),
                b["name"].as_str().unwrap_or(""),
            ) >= 700
        }) {
            continue;
        }
        seen.insert(n);
        merged.push(e.clone());
    }
    Json(merged).into_response()
}

// ── /api/spotlight ──

pub async fn spotlight(State(state): State<AppState>) -> impl IntoResponse {
    match anilist::get_ani_spotlight(&state.http).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/trending ──

pub async fn trending(State(state): State<AppState>) -> impl IntoResponse {
    match anilist::get_ani_trending(&state.http).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/popular ──

pub async fn popular(State(state): State<AppState>) -> impl IntoResponse {
    match anilist::get_ani_popular(&state.http).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/top-rated ──

pub async fn top_rated(State(state): State<AppState>) -> impl IntoResponse {
    match anilist::get_ani_top_rated(&state.http).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_502(&e),
    }
}

// ── /api/random ──

#[derive(Deserialize)]
pub struct RandomQ {
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

// Minimum average score (0-10 anime / TMDB scale).
const MIN_SCORE: f64 = 7.0;
// Share of shuffles that surface an underrated pick instead of a mainstream one.
const GEMS_SHARE_NUMERATOR: usize = 3;

static RAND_COUNTER: AtomicU64 = AtomicU64::new(0);

fn rand_below(n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    use std::collections::hash_map::RandomState;
    use std::hash::BuildHasher;
    let nanos = Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64;
    let c = RAND_COUNTER.fetch_add(1, Ordering::Relaxed);
    (RandomState::new().hash_one((nanos, c)) as usize) % n
}

fn add_movies(seen: &mut HashSet<String>, pool: &mut Vec<String>, list: &[Value], kind: &str) {
    for r in list {
        if r["id"].is_null() {
            continue;
        }
        let key = format!("{}-{}", kind, r["id"]);
        if !seen.insert(key) {
            continue;
        }
        if r["vote_average"].as_f64().unwrap_or(0.0) >= MIN_SCORE {
            pool.push(format!("/movies/{}?type={}", r["id"], kind));
        }
    }
}

async fn movie_pool() -> Result<String, String> {
    let (trending, trending_tv, top, top_tv) = tokio::join!(
        tmdb::get_trending(),
        tmdb::get_trending_tv(),
        tmdb::get_top_rated_movies(),
        tmdb::get_top_rated_tv(),
    );
    let mut seen: HashSet<String> = HashSet::new();
    let mut pool: Vec<String> = Vec::new();
    add_movies(&mut seen, &mut pool, &trending.unwrap_or_default(), "movie");
    add_movies(&mut seen, &mut pool, &trending_tv.unwrap_or_default(), "tv");
    add_movies(&mut seen, &mut pool, &top.unwrap_or_default(), "movie");
    add_movies(&mut seen, &mut pool, &top_tv.unwrap_or_default(), "tv");
    if pool.is_empty() {
        return Ok("/".into());
    }
    Ok(pool[rand_below(pool.len())].clone())
}

fn collect_ids(groups: &[&Vec<Value>], out: &mut Vec<String>) {
    let mut seen: HashSet<String> = HashSet::new();
    for g in groups {
        for item in *g {
            let id = item["_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| item["malId"].as_str().filter(|s| !s.is_empty()).map(String::from));
            let id = match id {
                Some(i) => i,
                None => continue,
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let score = &item["score"];
            if !score.is_null() && score.as_f64().map(|s| s >= MIN_SCORE).unwrap_or(false) {
                out.push(id);
            }
        }
    }
}

async fn anime_pool(client: &reqwest::Client) -> Result<String, String> {
    let (trending, popular, top, gems) = tokio::join!(
        anilist::get_ani_trending(client),
        anilist::get_ani_popular(client),
        anilist::get_ani_top_rated(client),
        anilist::get_ani_hidden_gems(client),
    );
    let trending = trending.unwrap_or_default();
    let popular = popular.unwrap_or_default();
    let top = top.unwrap_or_default();
    let gems = gems.unwrap_or_default();

    let mut main: Vec<String> = Vec::new();
    collect_ids(&[&trending, &popular, &top], &mut main);
    let mut gem_ids: Vec<String> = Vec::new();
    collect_ids(&[&gems], &mut gem_ids);

    // Prefer the underrated pool ~1/3 of the time (when it loaded).
    let pool = if !gem_ids.is_empty() && (main.is_empty() || rand_below(GEMS_SHARE_NUMERATOR) == 0)
    {
        gem_ids
    } else {
        main
    };
    if pool.is_empty() {
        return Ok("/".into());
    }
    Ok(format!("/anime/{}", pool[rand_below(pool.len())]))
}

pub async fn random(State(state): State<AppState>, Query(q): Query<RandomQ>) -> impl IntoResponse {
    let wants_movies = q.kind.as_deref() == Some("movie");
    // JSON (not a redirect): the client pushes one history entry per shuffle,
    // so Back lands on the previous pick instead of re-rolling.
    let url = if wants_movies {
        movie_pool().await.unwrap_or_else(|_| "/?tab=movies".to_string())
    } else {
        anime_pool(&state.http).await.unwrap_or_else(|_| "/".to_string())
    };
    Json(json!({ "url": url })).into_response()
}
