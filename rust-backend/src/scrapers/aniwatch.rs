// HiAnime-clone scraper (port of src/lib/aniwatch.ts). Owned by the stream
// migration. Returns one StreamResult-shaped JSON object or None.

use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::config::env_list;
use crate::safe_url::is_safe_url;
use crate::title_score::{normalize, score_title, MIN_SCORE};
use scraper::{ElementRef, Html, Selector};

use super::megaplay::extract_player_sources;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CACHE_TTL: Duration = Duration::from_millis(1_800_000);
const CACHE_MAX: usize = 500;

static CACHE: LazyLock<Mutex<HashMap<String, (Value, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn get_bases() -> Vec<String> {
    env_list("ANIWATCH_BASES", &["https://aniwatch.co.at"])
        .iter()
        .map(|s| crate::config::normalize_base(s))
        .collect()
}

fn headers_for(base: &str) -> Vec<(String, String)> {
    vec![
        ("User-Agent".into(), AGENT.into()),
        ("Referer".into(), format!("{}/", base)),
        ("X-Requested-With".into(), "XMLHttpRequest".into()),
    ]
}

fn with_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
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

// Sweep expired entries on write so a long-running server cannot accumulate
// one entry per (title, ep, mode) forever.
fn cache_set(key: String, val: Value) {
    let mut c = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if c.len() >= CACHE_MAX {
        let now = Instant::now();
        c.retain(|_, (_, ts)| now.duration_since(*ts) < CACHE_TTL);
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

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn film_name_text<'a>(nodes: impl Iterator<Item = ElementRef<'a>>) -> Option<String> {
    let name_sel = sel(".film-name");
    let mut out = String::new();
    for el in nodes {
        for t in el.select(&name_sel) {
            out.push_str(&t.text().collect::<String>());
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// Cheerio `.closest(".film-detail")`: self first, then ancestors; stop at the
// nearest match even if its name is empty (JS then tries the next alternative).
fn closest_film_name(node: ElementRef) -> Option<String> {
    let detail = sel(".film-detail");
    let mut cur = Some(node);
    while let Some(el) = cur {
        if detail.matches(&el) {
            return film_name_text(std::iter::once(el));
        }
        cur = el.parent().and_then(ElementRef::wrap);
    }
    None
}

struct Candidate {
    id: i64,
    title: String,
    score: i32,
}

async fn search_anime(
    client: &reqwest::Client,
    base: &str,
    title: &str,
) -> Result<Vec<Candidate>, String> {
    let url = format!("{}/?s={}", base, urlencoding::encode(title));
    let res = with_headers(client.get(&url), &headers_for(base))
        .timeout(Duration::from_millis(10000))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = res.text().await.map_err(|e| e.to_string())?;
    let document = Html::parse_document(&body);
    let poster = sel(".film-poster-ahref[data-id]");
    let detail = sel(".film-detail");

    let mut seen: HashSet<i64> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    for node in document.select(&poster) {
        let id: i64 = match node.attr("data-id").and_then(|v| v.parse().ok()) {
            Some(i) if i != 0 => i,
            _ => continue,
        };
        if !seen.insert(id) {
            continue;
        }
        let name = node
            .attr("title")
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                // The poster anchor is a *sibling* of .film-detail in hianime's
                // markup, so closest() alone always misses — walk up then across.
                let sibs = node
                    .prev_siblings()
                    .chain(node.next_siblings())
                    .filter_map(ElementRef::wrap);
                film_name_text(sibs.filter(|e| detail.matches(e)))
            })
            .or_else(|| closest_film_name(node))
            .or_else(|| {
                let parent = node.parent()?;
                let sibs = parent
                    .prev_siblings()
                    .chain(parent.next_siblings())
                    .filter_map(ElementRef::wrap);
                film_name_text(sibs.filter(|e| detail.matches(e)))
            })
            .unwrap_or_default();
        candidates.push(Candidate {
            id,
            score: score_title(title, &name),
            title: name,
        });
    }

    candidates.retain(|c| c.score >= MIN_SCORE);
    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    Ok(candidates)
}

async fn get_episode_id(
    client: &reqwest::Client,
    base: &str,
    anime_id: i64,
    ep: &str,
) -> Result<Option<i64>, String> {
    let url = format!("{}/wp-json/hianime/v1/episode/list/{}", base, anime_id);
    let res = with_headers(client.get(&url), &headers_for(base))
        .timeout(Duration::from_millis(10000))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let body = res.text().await.map_err(|e| e.to_string())?;
    // Payload is JSON with an `result`/`html` HTML blob; a raw body yields "".
    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let html = payload
        .get("result")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("html").and_then(|v| v.as_str()))
        .unwrap_or("");
    let document = Html::parse_document(html);
    let target = document
        .select(&sel(&format!(".ep-item[data-number=\"{}\"]", ep)))
        .next();
    Ok(target
        .and_then(|t| t.attr("data-id"))
        .and_then(|v| v.parse().ok())
        .filter(|&i| i != 0))
}

// JS atob: standard alphabet, throws on invalid input (-> "").
fn safe_atob(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let mut padded = cleaned;
    match padded.len() % 4 {
        0 => {}
        2 => padded.push_str("=="),
        3 => padded.push('='),
        _ => return String::new(),
    }
    base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default()
}

struct Srv {
    name: String,
    hash: Option<String>,
    server_id: Option<String>,
}

async fn get_embed_url(
    client: &reqwest::Client,
    base: &str,
    episode_id: i64,
    mode: &str,
) -> Result<Option<Value>, String> {
    let url = format!("{}/wp-json/hianime/v1/episode/servers/{}", base, episode_id);
    let res = with_headers(client.get(&url), &headers_for(base))
        .timeout(Duration::from_millis(10000))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let body = res.text().await.map_err(|e| e.to_string())?;

    let parsed = serde_json::from_str::<Value>(&body).ok();
    let payload = parsed.clone().unwrap_or(Value::Null);
    let html_like = match &parsed {
        Some(Value::Object(_)) => payload
            .get("result")
            .and_then(|v| v.as_str())
            .or_else(|| payload.get("html").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => String::new(),
        None => body.clone(),
    };
    let (typed, verified) = {
        let document = Html::parse_document(&html_like);

    let read_servers = |sel_str: &str, into: &mut Vec<Srv>| {
        for el in document.select(&sel(sel_str)) {
            let hash = el
                .attr("data-hash")
                .filter(|s| !s.is_empty())
                .map(String::from);
            let server_id = el
                .attr("data-server-id")
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| el.attr("data-id").filter(|s| !s.is_empty()).map(String::from));
            let name = el
                .attr("data-server-name")
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| el.text().collect::<String>().trim().to_string());
            if hash.is_some() || server_id.is_some() {
                into.push(Srv {
                    name,
                    hash,
                    server_id,
                });
            }
        }
    };

    let mut typed: Vec<Srv> = Vec::new();
    // Whether the audio variant was actually verified for this mode: a typed
    // .server-item[data-type=...] match or a mode-keyed structured entry proves
    // it; the untyped fallback proves nothing and must not claim dubCapable.
    let mut verified = false;
    read_servers(&format!(".server-item[data-type=\"{}\"]", mode), &mut typed);
    if !typed.is_empty() {
        verified = true;
    }

    if typed.is_empty() {
        // Only fall back to untyped servers when the payload carries no type
        // information at all — never silently hand back the other audio variant.
        let has_typed_servers = document.select(&sel(".server-item[data-type]")).next().is_some();
        if !has_typed_servers {
            read_servers(".server-item", &mut typed);
            if typed.is_empty() {
                // Mode-aware: the mode key proves the variant.
                let structured = payload
                    .get("result")
                    .and_then(|r| r.get(mode))
                    .filter(|v| !v.is_null())
                    .or_else(|| payload.get(mode).filter(|v| !v.is_null()))
                    .and_then(|v| v.as_array());
                if let Some(arr) = structured {
                    for s in arr {
                        if s.is_null() {
                            continue;
                        }
                        let server_id =
                            s.get("serverId").and_then(|v| v.as_str()).map(String::from);
                        if typed.iter().any(|x| x.server_id == server_id) {
                            continue;
                        }
                        typed.push(Srv {
                            name: s
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            hash: s.get("hash").and_then(|v| v.as_str()).map(String::from),
                            server_id,
                        });
                    }
                }
                if !typed.is_empty() {
                    verified = true;
                }
            }
            // else: plain untyped .server-item fallback — verified stays false
        }
        }
        (typed, verified)
    };

    for srv in &typed {
        // The player page is base64-encoded in data-hash and carries the audio
        // variant the server list already matched for this mode.
        let embed_url = srv.hash.as_deref().map(safe_atob).unwrap_or_default();
        if !embed_url.starts_with("http") {
            continue;
        }
        // The decoded hash is upstream-controlled — SSRF gate before fetching.
        if !is_safe_url(&embed_url).await {
            continue;
        }

        let check = with_headers(client.get(&embed_url), &headers_for(base))
            .timeout(Duration::from_millis(5000))
            .send()
            .await;
        let (status, page) = match check {
            Ok(r) => (r.status().as_u16(), r.text().await),
            Err(_) => continue,
        };
        let page = match page {
            Ok(p) => p,
            Err(_) => continue,
        };
        // 200 is not enough: taken-down embeds answer 200 with an "Error Code:"
        // body, which used to be handed to the player as alive.
        if status < 400 && !page.contains("Error Code:") {
            // Upgrade the embed to a direct stream when the player page
            // exposes one; the embed stays as the caller's fallback either way.
            let extracted = extract_player_sources(client, &embed_url, &format!("{}/", base))
                .await
                .unwrap_or_default()
                .into_iter()
                .next();
            let player_name = extracted
                .as_ref()
                .and_then(|v| v.get("playerName"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let server_name = match player_name {
                Some(p) => format!("Aniwatch {}", p),
                None => format!("Aniwatch-{}", srv.name),
            };
            let mut obj = Map::new();
            obj.insert("embedUrl".into(), json!(embed_url));
            obj.insert("serverName".into(), json!(server_name));
            obj.insert("title".into(), json!(""));
            obj.insert("dubCapable".into(), json!(verified));
            if let Some(ex) = extracted {
                if let Some(m) = ex.as_object() {
                    for (k, v) in m {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
            return Ok(Some(Value::Object(obj)));
        }
    }
    Ok(None)
}

pub async fn get_aniwatch_embed(
    client: &reqwest::Client,
    title: &str,
    ep: &str,
    mode: &str,
) -> Result<Option<Value>, String> {
    let key = format!(
        "aniwatch|{}|{}|{}",
        urlencoding::encode(title),
        ep,
        mode
    );
    if let Some(cached) = cache_get(&key) {
        return Ok(Some(cached));
    }

    let mut last_error: Option<String> = None;
    for base in get_bases() {
        let mut candidates = match search_anime(client, &base, title).await {
            Ok(c) => c,
            Err(e) => {
                last_error = Some(format!("{}: {}", base, trunc(&e, 80)));
                continue;
            }
        };
        // WordPress search chokes on long punctuation-heavy titles. Retry with
        // the part before the colon before writing this base off.
        if candidates.is_empty() {
            let short = title
                .split(&[':', '\u{2013}', '\u{2014}', '\u{2212}'][..])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if short.chars().count() >= 3 && normalize(&short) != normalize(title) {
                match search_anime(client, &base, &short).await {
                    Ok(c) => candidates = c,
                    Err(e) => {
                        last_error = Some(format!("{}: {}", base, trunc(&e, 80)));
                        continue;
                    }
                }
            }
        }
        if candidates.is_empty() {
            last_error = Some(format!(
                "\"{}\" not found on Aniwatch ({})",
                title, base
            ));
            continue;
        }

        // Walk the ranked candidates: search results mix seasons and spin-offs,
        // and the requested episode number often only exists on one of them.
        for candidate in candidates.iter().take(5) {
            let is_exact = normalize(&candidate.title) == normalize(title);
            // Per-candidate error so a failure on candidate 1 is not reported as
            // candidate 2's reason (stale lastError).
            let episode_id = match get_episode_id(client, &base, candidate.id, ep).await {
                Ok(id) => id,
                Err(e) => {
                    last_error = Some(trunc(&e, 80));
                    // Falling past an exact title match substitutes a spin-off —
                    // fail instead.
                    if is_exact {
                        break;
                    }
                    continue;
                }
            };
            let episode_id = match episode_id {
                Some(i) => i,
                None => {
                    last_error = Some(format!("Episode {} not on \"{}\"", ep, candidate.title));
                    if is_exact {
                        break;
                    }
                    continue;
                }
            };

            let mut candidate_error: Option<String> = None;
            let result = match get_embed_url(client, &base, episode_id, mode).await {
                Ok(r) => r,
                Err(e) => {
                    candidate_error = Some(trunc(&e, 80));
                    None
                }
            };
            if let Some(mut result) = result {
                result["title"] = json!(title);
                cache_set(key, result.clone());
                return Ok(Some(result));
            }
            last_error = Some(
                candidate_error.unwrap_or_else(|| {
                    format!("No {} server for \"{}\" ep {}", mode, candidate.title, ep)
                }),
            );
            // Exact show matched but has no server for this mode: a lower-ranked
            // hit would be a different show — never hand that back.
            if is_exact {
                break;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| format!("No {} source found on Aniwatch", mode)))
}
