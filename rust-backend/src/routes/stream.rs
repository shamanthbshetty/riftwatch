// Anime stream resolution route (port of src/app/api/stream/route.ts).
// Owned by the stream migration. Shape must match the TS route.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::allanime_client::get_show;
use crate::scrapers::anikoto::get_anikoto_embeds;
use crate::scrapers::aniwatch::get_aniwatch_embed;
use crate::scrapers::kenjitsu::get_kenjitsu_stream;
use crate::title_score::search_ready;
use crate::AppState;

#[derive(Deserialize)]
pub struct Q {
    id: Option<String>,
    ep: Option<String>,
    mode: Option<String>,
    title: Option<String>,
    retry: Option<String>,
}

static RE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,100}$").unwrap());
static RE_EP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,4}(\.\d{1,2})?$").unwrap());

// Negative cache: when every provider fails for a (show, episode, mode) — often
// because an upstream search times out (Anizone has been seen hanging 15s+ on
// specific queries) — remember it briefly so repeat requests fail instantly
// instead of re-waiting every provider timeout on each page load.
const FAIL_TTL: Duration = Duration::from_secs(60);
const FAIL_MAX: usize = 500;

static FAIL_CACHE: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn note_failure(key: &str) {
    let mut c = FAIL_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if c.len() >= FAIL_MAX {
        if let Some(oldest) = c.iter().min_by_key(|(_, ts)| **ts).map(|(k, _)| k.clone()) {
            c.remove(&oldest);
        }
    }
    c.insert(key.to_string(), Instant::now());
}

// Per-provider timeout: one hanging upstream (Anizone has been seen hanging
// 15s+ on specific queries) must not stall the whole server list — the
// negative cache above already guards repeat visits.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(10);

async fn with_provider_timeout<F, T>(fut: F, label: &str, fallback: T) -> T
where
    F: std::future::Future<Output = Result<T, String>>,
{
    match tokio::time::timeout(PROVIDER_TIMEOUT, fut).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(
                "[stream] {} failed: {}",
                label,
                e.chars().take(200).collect::<String>()
            );
            fallback
        }
        Err(_) => {
            tracing::warn!("[stream] {} timed out after 10000ms", label);
            fallback
        }
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

struct Resolved {
    name: String,
    english_name: Option<String>,
}

async fn resolve_show_name(
    client: &reqwest::Client,
    id: &str,
    fallback_title: Option<&str>,
) -> Option<Resolved> {
    if let Some(kitsu_id) = id.strip_prefix("kitsu-") {
        let kitsu = async {
            let res = client
                .get(format!(
                    "https://kitsu.io/api/edge/anime/{}",
                    urlencoding::encode(kitsu_id)
                ))
                .header("Accept", "application/vnd.api+json")
                .timeout(Duration::from_secs(8))
                .send()
                .await
                .ok()?;
            if !res.status().is_success() {
                return None;
            }
            let j = res.json::<Value>().await.ok()?;
            let attrs = &j["data"]["attributes"];
            if attrs.is_null() {
                return None;
            }
            let name = attrs["titles"]["en"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    attrs["titles"]["en_jp"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| {
                    attrs["canonicalTitle"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or("");
            Some(Resolved {
                name: search_ready(name),
                english_name: attrs["titles"]["en"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            })
        }
        .await;
        if kitsu.is_some() {
            return kitsu;
        }
        return fallback_title.map(|f| Resolved {
            name: search_ready(f),
            english_name: None,
        });
    }

    // AllAnime API may be down — treat a failed lookup as "no show".
    if let Ok(show) = get_show(id).await {
        return Some(Resolved {
            name: search_ready(&show.name),
            english_name: show.english_name,
        });
    }

    // The id may be a MAL id (e.g. from the airing schedule) or an AniList id
    // rather than an AllAnime hash. Try AniList before giving up so a dead
    // AllAnime mirror doesn't 404 the whole request.
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        let anilist = async {
            for field in ["id", "idMal"] {
                let query = format!(
                    "query($id: Int!) {{ Media({}: $id, type: ANIME) {{ title {{ english romaji }} }} }}",
                    field
                );
                let body = json!({ "query": query, "variables": { "id": id.parse::<i64>().unwrap_or(0) } });
                let res = client
                    .post("https://graphql.anilist.co")
                    .json(&body)
                    .timeout(Duration::from_secs(8))
                    .send()
                    .await
                    .ok()?;
                if !res.status().is_success() {
                    continue;
                }
                let j = res.json::<Value>().await.ok()?;
                let title = &j["data"]["Media"]["title"];
                let name = title["english"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| title["romaji"].as_str().filter(|s| !s.is_empty()));
                if let Some(name) = name {
                    return Some(Resolved {
                        name: search_ready(name),
                        english_name: title["english"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                    });
                }
            }
            None
        }
        .await;
        if anilist.is_some() {
            return anilist;
        }
    }

    fallback_title.map(|f| Resolved {
        name: search_ready(f),
        english_name: None,
    })
}

enum ResolveErr {
    NotFound,
    // Sources came back empty — message already carries the sub/dub wording.
    NoSources(String),
}

fn push_source(r: &Value, wants_dub: bool, seen: &mut HashSet<String>, out: &mut Vec<Value>) {
    // Providers that ignore the requested audio variant (Anizone, Animeheaven)
    // would hand back Japanese audio under a DUB request, so drop them there.
    if wants_dub && r["dubCapable"] != Value::Bool(true) {
        return;
    }
    // Anikoto and Aniwatch routinely resolve to the identical Megaplay
    // player — listing both is fake failover (one dies, so does the other).
    // Dedupe on the actual media being served; name/url variants of the
    // same file collapse to the higher-priority server.
    let media_key = r["streamUrl"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| r["embedUrl"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string();
    if !seen.insert(media_key) {
        return;
    }
    let has_stream = r["streamUrl"].as_str().map(|s| !s.is_empty()).unwrap_or(false);
    let mut obj = Map::new();
    obj.insert("sourceName".into(), r["serverName"].clone());
    obj.insert("sourceUrl".into(), r["embedUrl"].clone());
    obj.insert("type".into(), json!("text/html"));
    obj.insert("isEmbed".into(), json!(!has_stream));
    if has_stream {
        obj.insert("streamUrl".into(), r["streamUrl"].clone());
        if r.get("subtitles").map(|v| !v.is_null()).unwrap_or(false) {
            obj.insert("subtitles".into(), r["subtitles"].clone());
        }
    }
    if truthy(r.get("intro")) {
        obj.insert("intro".into(), r["intro"].clone());
    }
    if truthy(r.get("outro")) {
        obj.insert("outro".into(), r["outro"].clone());
    }
    out.push(Value::Object(obj));
}

async fn resolve_sources(
    state: &AppState,
    id: &str,
    ep: &str,
    mode: &str,
    fallback_title: Option<&str>,
) -> Result<Vec<Value>, ResolveErr> {
    let resolved =
        resolve_show_name(&state.http, id, fallback_title)
            .await
            .ok_or(ResolveErr::NotFound)?;
    // Upstream sites (aniwatch/anikoto) index by English titles, so prefer the
    // English name for searching; fall back to the romaji name when missing.
    let show_name = resolved
        .english_name
        .as_deref()
        .map(search_ready)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| resolved.name.clone());

    // Kenjitsu's providers are sub-only (version param is a no-op) — skip the
    // 3 upstream round-trips entirely on dub requests instead of filtering later.
    let anikoto = with_provider_timeout(
        get_anikoto_embeds(&state.http, &show_name, ep, mode),
        "anikoto",
        Vec::new(),
    );
    let aniwatch = with_provider_timeout(
        get_aniwatch_embed(&state.http, &show_name, ep, mode),
        "aniwatch",
        None,
    );
    let kenjitsu = async {
        if mode == "dub" {
            Vec::new()
        } else {
            with_provider_timeout(
                get_kenjitsu_stream(&state.http, &show_name, ep, mode),
                "kenjitsu",
                Vec::new(),
            )
            .await
        }
    };
    let (anikoto, aniwatch, kenjitsu) = tokio::join!(anikoto, aniwatch, kenjitsu);

    let mut seen_media: HashSet<String> = HashSet::new();
    let mut sources: Vec<Value> = Vec::new();
    let wants_dub = mode == "dub";

    // Anikoto first (user preference — its extracted "Vidstream-1" HLS carries
    // the most subtitle tracks and skip windows), Aniwatch second as failover.
    for k in &anikoto {
        push_source(k, wants_dub, &mut seen_media, &mut sources);
    }
    // Then Kenjitsu (Anizone, Animeheaven) — sub-only, so dub requests skip these
    if let Some(a) = &aniwatch {
        push_source(a, wants_dub, &mut seen_media, &mut sources);
    }
    for k in &kenjitsu {
        push_source(k, wants_dub, &mut seen_media, &mut sources);
    }

    if sources.is_empty() {
        let msg = if wants_dub {
            "No dubbed sources available for this episode."
        } else {
            "No sources found"
        };
        return Err(ResolveErr::NoSources(msg.to_string()));
    }
    Ok(sources)
}

#[axum::debug_handler]
pub async fn handler(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    let id = q.id.unwrap_or_default();
    let ep_raw = q.ep.unwrap_or_default();
    let mode_raw = q.mode.unwrap_or_else(|| "sub".to_string()).to_lowercase();
    let fallback_title = q.title.filter(|t| !t.is_empty());

    if id.is_empty() || ep_raw.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "id and ep required"}))).into_response();
    }
    // id reaches downstream fetch URLs (kitsu path segment) — same shape gate as
    // /api/episodes so garbage ids can't be interpolated into request paths.
    if !RE_ID.is_match(&id) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid id"}))).into_response();
    }
    // Validate before any provider call: ep lands inside an attribute selector
    // downstream, and an arbitrary mode string would silently disable the
    // sub/dub filter (mode === "dub" would be false for "DUB").
    if !RE_EP.is_match(&ep_raw) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "ep must be a number"}))).into_response();
    }
    if mode_raw != "sub" && mode_raw != "dub" {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "mode must be sub or dub"}))).into_response();
    }
    let ep = ep_raw;
    let mode = mode_raw;

    let fail_key = format!("{}|{}|{}", id, ep, mode);
    // The user's Retry must actually re-run the providers, not replay the
    // negative cache that got it here.
    let is_retry = q
        .retry
        .as_deref()
        .map(|s| s.trim().parse::<f64>().map(|n| n >= 1.0).unwrap_or(false))
        .unwrap_or(false);
    if !is_retry {
        let mut cache = FAIL_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(&failed_at) = cache.get(&fail_key) {
            if failed_at.elapsed() < FAIL_TTL {
                drop(cache);
                return (StatusCode::BAD_GATEWAY, Json(json!({"error": "No sources found"})))
                    .into_response();
            }
            cache.remove(&fail_key);
        }
    }

    match resolve_sources(&state, &id, &ep, &mode, fallback_title.as_deref()).await {
        Ok(sources) => Json(json!({"sourceUrls": sources})).into_response(),
        Err(ResolveErr::NotFound) => {
            (StatusCode::NOT_FOUND, Json(json!({"error": "Anime not found"}))).into_response()
        }
        Err(ResolveErr::NoSources(msg)) => {
            note_failure(&fail_key);
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
        }
    }
}
