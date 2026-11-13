// TMDB client (port of src/lib/movies.ts). Owned by the movies migration.
//
// Plain HTTP on purpose: api.themoviedb.org's TLS handshake is being reset at
// the network level from some networks; the key is public anyway.

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

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
