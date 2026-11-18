// TMDB client (port of src/lib/movies.ts). Owned by the movies migration.
//
// Plain HTTP on purpose: api.themoviedb.org's TLS handshake is being reset at
// the network level from some networks; the key is public anyway.

use serde_json::{json, Map, Value};
use std::sync::OnceLock;
use std::time::Duration;

use crate::title_score;

const TMDB_BASE: &str = "http://api.themoviedb.org/3";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

fn key() -> String {
    crate::config::env_str("TMDB_API_KEY", "")
}

/// Client for the frozen no-arg entry points; route handlers pass `state.http`.
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("tmdb client")
    })
}

/// GET a TMDB path with api_key, retrying 5xx up to 3 times (4xx bails out).
pub async fn tmdb_fetch(
    client: &reqwest::Client,
    path: &str,
    params: &[(&str, String)],
) -> Result<Value, String> {
    let mut url = format!("{}{}?api_key={}", TMDB_BASE, path, urlencoding::encode(&key()));
    for (k, v) in params {
        url.push('&');
        url.push_str(&format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)));
    }
    for attempt in 0..3u32 {
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(res) if res.status().is_success() => match res.json::<Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if attempt == 2 {
                        return Err(e.to_string());
                    }
                }
            },
            Ok(res) => {
                let status = res.status().as_u16();
                // 4xx (bad key, not found) will never become 2xx on retry — bail
                // out instead of hitting TMDB 3× with the same broken request.
                if status < 500 {
                    return Err(format!("TMDB {}: {}", status, path));
                }
            }
            Err(e) => {
                if attempt == 2 {
                    return Err(e.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
    }
    Err(format!("TMDB failed after retries: {}", path))
}

/// Released-date gate shared by every listing: only titles already out.
/// Missing date = keep (same lenient default the trending filters always had).
pub fn is_released(r: &Value) -> bool {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date = if r["media_type"].as_str() == Some("tv") {
        nonempty(r["first_air_date"].as_str()).or_else(|| nonempty(r["release_date"].as_str()))
    } else {
        nonempty(r["release_date"].as_str()).or_else(|| nonempty(r["first_air_date"].as_str()))
    };
    date.map_or(true, |d| d <= today.as_str())
}

fn nonempty(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

fn results(v: &Value) -> Vec<Value> {
    v.get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}

fn filter_released(items: Vec<Value>) -> Vec<Value> {
    items.into_iter().filter(is_released).collect()
}

/// `{ ...data, results }` with a non-object data coerced to `{}` like object spread.
fn envelope_results(data: Value, items: Vec<Value>) -> Value {
    let mut data = data;
    if !data.is_object() {
        data = json!({});
    }
    if let Some(obj) = data.as_object_mut() {
        obj.insert("results".into(), Value::Array(items));
    }
    data
}

pub async fn trending(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    let data = tmdb_fetch(client, "/trending/movie/week", &[]).await?;
    Ok(results(&data)
        .into_iter()
        .filter(|r| {
            matches!(r["media_type"].as_str(), None | Some("") | Some("movie")) && is_released(r)
        })
        .collect())
}

pub async fn trending_tv(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    let data = tmdb_fetch(client, "/trending/tv/week", &[]).await?;
    Ok(filter_released(results(&data)))
}

pub async fn search(client: &reqwest::Client, query: &str, page: &str) -> Result<Value, String> {
    let data = tmdb_fetch(
        client,
        "/search/multi",
        &[
            ("query", query.to_string()),
            ("page", page.to_string()),
            ("include_adult", "false".to_string()),
        ],
    )
    .await?;
    let filtered = filter_released(results(&data));
    Ok(envelope_results(data, filtered))
}

pub async fn popular(client: &reqwest::Client, typ: &str) -> Result<Value, String> {
    let path = if typ == "tv" { "/tv/popular" } else { "/movie/popular" };
    let data = tmdb_fetch(client, path, &[("page", "1".to_string())]).await?;
    let filtered = filter_released(results(&data));
    Ok(envelope_results(data, filtered))
}

pub async fn top_rated(client: &reqwest::Client, typ: &str) -> Result<Value, String> {
    let path = if typ == "tv" { "/tv/top_rated" } else { "/movie/top_rated" };
    let data = tmdb_fetch(client, path, &[("page", "1".to_string())]).await?;
    let filtered = filter_released(results(&data));
    Ok(envelope_results(data, filtered))
}

pub async fn details(client: &reqwest::Client, is_tv: bool, id: &str) -> Result<Value, String> {
    let path = if is_tv {
        format!("/tv/{}", id)
    } else {
        format!("/movie/{}", id)
    };
    tmdb_fetch(client, &path, &[]).await
}

pub async fn credits(client: &reqwest::Client, is_tv: bool, id: &str) -> Result<Value, String> {
    let path = if is_tv {
        format!("/tv/{}/credits", id)
    } else {
        format!("/movie/{}/credits", id)
    };
    tmdb_fetch(client, &path, &[]).await
}

pub async fn videos(client: &reqwest::Client, is_tv: bool, id: &str) -> Result<Value, String> {
    let path = if is_tv {
        format!("/tv/{}/videos", id)
    } else {
        format!("/movie/{}/videos", id)
    };
    tmdb_fetch(client, &path, &[]).await
}

/// TMDB "More like this" — media_type tagged so links hit the right detail URL.
pub async fn recommendations(
    client: &reqwest::Client,
    typ: &str,
    id: &str,
) -> Result<Vec<Value>, String> {
    let data = tmdb_fetch(client, &format!("/{}/{}/recommendations", typ, id), &[]).await?;
    Ok(results(&data)
        .into_iter()
        .map(|r| {
            let mut obj = r.as_object().cloned().unwrap_or_default();
            obj.insert("media_type".into(), json!(typ));
            Value::Object(obj)
        })
        .filter(|r| is_released(r))
        .collect())
}

pub async fn tv_season(client: &reqwest::Client, id: &str, season: &str) -> Result<Value, String> {
    tmdb_fetch(client, &format!("/tv/{}/season/{}", id, season), &[]).await
}

pub async fn tv_total_episodes(client: &reqwest::Client, id: &str) -> Result<u64, String> {
    let details = tmdb_fetch(client, &format!("/tv/{}", id), &[]).await?;
    // Skip season 0 (specials) — counting them inflated the episode count.
    let mut total = 0.0f64;
    if let Some(seasons) = details.get("seasons").and_then(|s| s.as_array()) {
        for s in seasons {
            if s.get("season_number").and_then(|n| n.as_f64()) == Some(0.0) {
                continue;
            }
            total += s.get("episode_count").and_then(|n| n.as_f64()).unwrap_or(0.0);
        }
    }
    Ok(total as u64)
}

pub async fn get_trending() -> Result<Vec<Value>, String> {
    trending(shared_client()).await
}

pub async fn get_trending_tv() -> Result<Vec<Value>, String> {
    trending_tv(shared_client()).await
}

/// Returns the inner results array (not the TMDB `{results:...}` envelope).
pub async fn get_top_rated_movies() -> Result<Vec<Value>, String> {
    let data = top_rated(shared_client(), "movie").await?;
    Ok(results(&data))
}

/// Returns the inner results array (not the TMDB `{results:...}` envelope).
pub async fn get_top_rated_tv() -> Result<Vec<Value>, String> {
    let data = top_rated(shared_client(), "tv").await?;
    Ok(results(&data))
}

// ── Anime episode titles (fallback when Kitsu has none) ──

/// Find the TMDB TV id whose English/original title matches `title`
/// (exact/starts-with level — the same conservative threshold the provider
/// search uses, so a sequel can't donate its titles to the wrong show).
async fn tv_id_by_title(client: &reqwest::Client, title: &str) -> Option<u64> {
    let t = title.trim();
    if t.is_empty() {
        return None;
    }
    let data = tmdb_fetch(
        client,
        "/search/tv",
        &[("query", t.to_string()), ("include_adult", "false".to_string())],
    )
    .await
    .ok()?;
    let mut best: Option<(i32, u64)> = None;
    for r in results(&data) {
        let mut score = 0;
        for cand in [r["name"].as_str(), r["original_name"].as_str()] {
            if let Some(c) = cand {
                score = score.max(title_score::score_title(t, c));
            }
        }
        if score < 700 {
            continue;
        }
        let id = r["id"].as_i64()?;
        if id > 0 && best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, id as u64));
        }
    }
    best.map(|(_, id)| id)
}

/// English episode titles keyed by ABSOLUTE episode number (the numbering the
/// app and MAL use). Seasons are walked in ascending order and the first title
/// for a number wins: TMDB sometimes splits one long anime across several
/// "seasons" that all restart at episode 1, and renumbering those would shift
/// every title onto the wrong episode.
pub async fn episode_titles(client: &reqwest::Client, title: &str) -> Result<Value, String> {
    let mut out = Map::new();
    let id = match tv_id_by_title(client, title).await {
        Some(id) => id,
        None => return Ok(Value::Object(out)),
    };
    let details = tmdb_fetch(client, &format!("/tv/{}", id), &[]).await?;
    let mut seasons: Vec<u64> = details["seasons"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let n = s["season_number"].as_f64()?;
                    // Season 0 = specials; counting/using them shifts numbering.
                    if n <= 0.0 {
                        None
                    } else {
                        Some(n as u64)
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    seasons.sort_unstable();
    seasons.dedup();
    // Fetch all seasons in parallel, but apply results in ascending season
    // order so "first title for a number wins" stays deterministic.
    let mut season_data: Vec<(u64, Value)> = Vec::with_capacity(seasons.len());
    let mut futs = Vec::with_capacity(seasons.len());
    for &season in &seasons {
        let url = format!("/tv/{}/season/{}", id, season);
        futs.push(async move {
            let data = tmdb_fetch(client, &url, &[]).await.ok();
            (season, data.unwrap_or(Value::Null))
        });
    }
    let results = futures::future::join_all(futs).await;
    for (season, data) in results {
        season_data.push((season, data));
    }
    season_data.sort_by_key(|(s, _)| *s);
    for (_, data) in season_data {
        let eps = match data["episodes"].as_array() {
            Some(e) => e,
            None => continue,
        };
        for ep in eps {
            let name = match ep["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(n) => n,
                None => continue,
            };
            let num = match ep["episode_number"].as_i64() {
                Some(n) => n,
                None => continue,
            };
            out.entry(num.to_string()).or_insert(json!(name));
        }
    }
    Ok(Value::Object(out))
}
