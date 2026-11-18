// Kenjitsu (Anizone / Animeheaven) scraper (port of src/lib/kenjitsu.ts).
// Owned by the stream migration. Sub-only upstream — callers skip it for dub.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::config::{env_list, env_str, normalize_base};
use crate::title_score::rank_candidates;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const CACHE_TTL: Duration = Duration::from_millis(1_800_000);
const CACHE_MAX: usize = 500;
const FETCH_TIMEOUT_MS: u64 = 10000;

static CACHE: LazyLock<Mutex<HashMap<String, (Value, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn get_bases() -> Vec<String> {
    const DEFAULT_KENJITSU_BASE: &str = "https://kenjitsu.vercel.app";
    let singular = env_str("KENJITSU_BASE", "");
    let singular = singular.trim();
    let defaults: Vec<&str> = if !singular.is_empty() && singular != DEFAULT_KENJITSU_BASE {
        vec![singular, DEFAULT_KENJITSU_BASE]
    } else {
        vec![DEFAULT_KENJITSU_BASE]
    };
    env_list("KENJITSU_BASES", &defaults)
        .iter()
        .map(|s| normalize_base(s))
        .collect()
}

fn cache_get(key: &str) -> Option<Value> {
    let c = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    c.get(key).and_then(|(v, ts)| {
        if ts.elapsed() < CACHE_TTL {
            Some(v.clone())
        } else {
            None
        }
    })
}

fn cache_set(key: String, val: Value) {
    let mut c = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if c.len() >= CACHE_MAX {
        let now = Instant::now();
        c.retain(|_, (_, ts)| now.duration_since(*ts) < CACHE_TTL);
        // Still full after expiry sweep → drop oldest.
        while c.len() >= CACHE_MAX {
            match c.iter().min_by_key(|(_, v)| v.1) {
                Some((k, _)) => {
                    let k = k.clone();
                    c.remove(&k);
                }
                None => break,
            }
        }
    }
    c.insert(key, (val, Instant::now()));
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

// JS String() for JSON values (episodeNumber is a number upstream).
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => n.as_f64().map(|f| format!("{}", f)).unwrap_or_default(),
        },
        other => other.to_string(),
    }
}

// Pick the provider result that is the requested show by identity — exact
// title first, then the same base work. Never fall through to an arbitrary
// first hit; a non-match returns None.
fn pick_best(query: &str, results: &[Value]) -> Option<Value> {
    let titles: Vec<String> = results
        .iter()
        .map(|r| r["name"].as_str().unwrap_or("").to_string())
        .collect();
    let ordered = rank_candidates(query, &titles);
    ordered.first().map(|&i| results[i].clone())
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let res = client
        .get(url)
        .header(reqwest::header::USER_AGENT, AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<Value>().await.ok()
}

async fn search_provider(
    client: &reqwest::Client,
    base: &str,
    provider: &str,
    title: &str,
) -> Option<Value> {
    let url = format!(
        "{}/api/{}/anime/search?q={}",
        base,
        provider,
        urlencoding::encode(title)
    );
    let data = fetch_json(client, &url).await?;
    let results = data.get("data")?.as_array()?;
    if results.is_empty() {
        return None;
    }
    pick_best(title, results)
}

async fn get_anizone_stream(
    client: &reqwest::Client,
    base: &str,
    title: &str,
    ep: &str,
    mode: &str,
) -> Option<Value> {
    let show = search_provider(client, base, "anizone", title).await?;
    let show_id = match show.get("id")? {
        Value::String(s) => s.clone(),
        Value::Number(_) => js_string(&show["id"]),
        _ => return None,
    };

    let detail = fetch_json(
        client,
        &format!("{}/api/anizone/anime/{}", base, urlencoding::encode(&show_id)),
    )
    .await?;
    let episodes = detail.get("providerEpisodes")?.as_array()?;
    if episodes.is_empty() {
        return None;
    }
    // No fallback to episodes[0]: serving a wrong episode on a wrong ID match
    // is worse than reporting the provider had nothing.
    let target = episodes.iter().find(|e| js_string(&e["episodeNumber"]) == ep)?;
    let episode_id = target.get("episodeId")?;
    let episode_id = match episode_id {
        Value::String(s) => s.clone(),
        Value::Number(_) => js_string(episode_id),
        _ => return None,
    };

    let sources_data = fetch_json(
        client,
        &format!(
            "{}/api/anizone/sources/{}?version={}",
            base,
            urlencoding::encode(&episode_id),
            mode
        ),
    )
    .await?;
    let sources = sources_data["data"]["sources"].as_array()?;
    if sources.is_empty() {
        return None;
    }
    let src = sources
        .iter()
        .find(|s| truthy(&s["isM3u8"]))
        .or_else(|| sources.first())?;
    let src_url = src.get("url")?.as_str()?;
    let referer = sources_data["headers"]["Referer"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("https://anizone.to/");

    let mut subtitles: Vec<Value> = Vec::new();
    if let Some(arr) = sources_data["data"]["subtitles"].as_array() {
        for s in arr {
            let s_url = s.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let label = s
                .get("lang")
                .and_then(|v| v.as_str())
                .filter(|l| !l.is_empty())
                .unwrap_or("Subtitles");
            subtitles.push(json!({
                "label": label,
                "url": format!(
                    "/api/movies/subtitle-proxy?url={}&referer={}",
                    urlencoding::encode(s_url),
                    urlencoding::encode(referer)
                ),
                "srclang": "en",
            }));
        }
    }

    Some(json!({
        "embedUrl": "",
        "serverName": "Anizone",
        "title": title,
        "streamUrl": format!(
            "/api/movies/m3u8-proxy?url={}&referer={}",
            urlencoding::encode(src_url),
            urlencoding::encode(referer)
        ),
        "subtitles": subtitles,
        // Anizone's sources endpoint ignores the requested version and always
        // returns the same Japanese-audio stream, so it can never serve a dub.
        "dubCapable": false,
    }))
}

async fn get_animeheaven_stream(
    client: &reqwest::Client,
    base: &str,
    title: &str,
    ep: &str,
    mode: &str,
) -> Option<Value> {
    let show = search_provider(client, base, "animeheaven", title).await?;
    let show_id = match show.get("id")? {
        Value::String(s) => s.clone(),
        Value::Number(_) => js_string(&show["id"]),
        _ => return None,
    };

    let detail = fetch_json(
        client,
        &format!(
            "{}/api/animeheaven/anime/{}",
            base,
            urlencoding::encode(&show_id)
        ),
    )
    .await?;
    let episodes = detail.get("providerEpisodes")?.as_array()?;
    if episodes.is_empty() {
        return None;
    }
    let target = episodes.iter().find(|e| js_string(&e["episodeNumber"]) == ep)?;
    let episode_id = target.get("episodeId")?;
    let episode_id = match episode_id {
        Value::String(s) => s.clone(),
        Value::Number(_) => js_string(episode_id),
        _ => return None,
    };

    let sources_data = fetch_json(
        client,
        &format!(
            "{}/api/animeheaven/sources/{}?version={}",
            base,
            urlencoding::encode(&episode_id),
            mode
        ),
    )
    .await?;
    let sources = sources_data["data"]["sources"].as_array()?;
    if sources.is_empty() {
        return None;
    }
    let src = &sources[0];
    let src_url = src.get("url")?.as_str()?;
    let referer = sources_data["headers"]["Referer"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("https://animeheaven.me/");

    // URL shape wins over the upstream flag: an .m3u8 URL routed to the mp4
    // proxy (or vice versa) plays nothing.
    let is_mp4 = !src_url.contains(".m3u8")
        && (src_url.contains(".mp4") || !truthy(&src["isM3u8"]));
    let proxy_path = if is_mp4 {
        "/api/movies/mp4-proxy"
    } else {
        "/api/movies/m3u8-proxy"
    };

    let mut subtitles: Vec<Value> = Vec::new();
    if let Some(arr) = sources_data["data"]["subtitles"].as_array() {
        for s in arr {
            let s_url = s.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let label = s
                .get("label")
                .and_then(|v| v.as_str())
                .filter(|l| !l.is_empty())
                .or_else(|| {
                    s.get("lang")
                        .and_then(|v| v.as_str())
                        .filter(|l| !l.is_empty())
                })
                .unwrap_or("Subtitles");
            let lang = s.get("lang").and_then(|v| v.as_str()).unwrap_or("en");
            let srclang: String = lang.chars().take(2).collect::<String>().to_lowercase();
            subtitles.push(json!({
                "label": label,
                "url": format!(
                    "/api/movies/subtitle-proxy?url={}&referer={}",
                    urlencoding::encode(s_url),
                    urlencoding::encode(referer)
                ),
                "srclang": srclang,
            }));
        }
    }

    Some(json!({
        "embedUrl": "",
        "serverName": "Animeheaven",
        "title": title,
        "streamUrl": format!(
            "{}?url={}&referer={}",
            proxy_path,
            urlencoding::encode(src_url),
            urlencoding::encode(referer)
        ),
        "subtitles": subtitles,
        // Verified upstream: ?version=sub and ?version=dub return
        // byte-identical URLs, so this provider is sub-only.
        "dubCapable": false,
    }))
}

pub async fn get_kenjitsu_stream(
    client: &reqwest::Client,
    title: &str,
    ep: &str,
    mode: &str,
) -> Result<Vec<Value>, String> {
    let key = format!("kenjitsu|{}|{}|{}", urlencoding::encode(title), ep, mode);
    if let Some(cached) = cache_get(&key) {
        return Ok(cached.as_array().cloned().unwrap_or_default());
    }

    for base in get_bases() {
        let (anizone, animeheaven) = tokio::join!(
            get_anizone_stream(client, &base, title, ep, mode),
            get_animeheaven_stream(client, &base, title, ep, mode),
        );

        let mut results: Vec<Value> = Vec::new();
        if let Some(a) = anizone {
            results.push(a);
        }
        if let Some(h) = animeheaven {
            results.push(h);
        }

        if !results.is_empty() {
            cache_set(key, json!(results));
            return Ok(results);
        }
    }

    Ok(vec![])
}
