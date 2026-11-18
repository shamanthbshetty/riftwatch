// Anikoto WordPress-mirror scraper (port of src/lib/anikoto.ts). Owned by the
// stream migration. Returns StreamResult-shaped JSON objects.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::config::{env_list, parse_mirror_list};
use crate::safe_url::is_safe_url;
use crate::title_score::{score_title, MIN_SCORE};
use scraper::{ElementRef, Html, Selector};

use super::megaplay::extract_player_sources;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CACHE_TTL: Duration = Duration::from_millis(1_800_000);
const CACHE_MAX: usize = 500;

static CACHE: LazyLock<Mutex<HashMap<String, (Value, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RE_DATA_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"data-id="(\d+)""#).unwrap());

// Each mirror is exposed as its own player so users can fail over between them.
// Override/extend without editing source:
//   ANIKOTO_MIRRORS=https://anikoto.cz|Anikoto CZ,https://new-mirror.to|Anikoto NEW
const DEFAULT_MIRRORS: [(&str, &str); 4] = [
    ("https://anikoto.cz", "Anikoto CZ"),
    ("https://anikototv.to", "Anikoto"),
    ("https://anikoto.me", "Anikoto ME"),
    ("https://anikoto.net", "Anikoto NET"),
];

fn get_mirrors() -> Vec<(String, String)> {
    let default_entries: Vec<String> = DEFAULT_MIRRORS
        .iter()
        .map(|(h, l)| format!("{}|{}", h, l))
        .collect();
    let defaults: Vec<&str> = default_entries.iter().map(|s| s.as_str()).collect();
    let entries = env_list("ANIKOTO_MIRRORS", &defaults);
    parse_mirror_list(&entries, &DEFAULT_MIRRORS)
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

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

// axios-like GET: throws on network error and on non-2xx.
async fn get_text(client: &reqwest::Client, url: &str, timeout_ms: u64) -> Result<String, String> {
    let res = client
        .get(url)
        .header(reqwest::header::USER_AGENT, AGENT)
        .header("X-Requested-With", "XMLHttpRequest")
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

// Pre-extraction source: everything StreamResult carries plus the upstream
// player label — which is often a lie ("Vidstream-1" for a Megaplay player),
// so the final name prefers the extracted playerName.
struct AnikotoSource {
    embed_url: String,
    label: String,
    server_label: String,
    title: String,
    dub_capable: bool,
}

fn consider(
    href: Option<&str>,
    name: &str,
    title: &str,
    seen: &mut HashSet<String>,
    candidates: &mut Vec<(String, i32)>,
) {
    let href = match href {
        Some(h) if !h.is_empty() => h,
        _ => return,
    };
    if !seen.insert(href.to_string()) {
        return;
    }
    let score = score_title(title, name);
    if score >= MIN_SCORE {
        candidates.push((href.to_string(), score));
    }
}

async fn resolve_from_mirror(
    client: &reqwest::Client,
    mirror: &(String, String),
    title: &str,
    ep: &str,
    mode: &str,
) -> Result<AnikotoSource, String> {
    let (host, label) = (mirror.0.as_str(), mirror.1.as_str());

    // 1. Search — WordPress returns both series pages and individual episode
    //    permalinks, so rank candidates instead of taking the first hit.
    let search_url = format!("{}/search?keyword={}", host, urlencoding::encode(title));
    let body = get_text(client, &search_url, 8000).await?;
    let candidates = {
        let document = Html::parse_document(&body);

        let mut seen: HashSet<String> = HashSet::new();
        let mut candidates: Vec<(String, i32)> = Vec::new();

    // Each result is an .item holding a poster link plus a `a.name` title link.
    let items: Vec<ElementRef> = document.select(&sel("#list-items .item")).collect();
    if !items.is_empty() {
        let name_link_sel = sel("a.name, a.d-title");
        let href_sel = sel("a[href]");
        let img_sel = sel("img");
        for item in items {
            let name_link = item.select(&name_link_sel).next();
            let href = name_link
                .and_then(|n| n.attr("href"))
                .filter(|h| !h.is_empty())
                .or_else(|| item.select(&href_sel).next().and_then(|n| n.attr("href")));
            let name = name_link
                .map(|n| n.text().collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    item.select(&img_sel)
                        .next()
                        .and_then(|i| i.attr("alt"))
                        .map(String::from)
                })
                .unwrap_or_default();
            consider(href, &name, title, &mut seen, &mut candidates);
        }
    } else {
        let img_sel = sel("img");
        for node in document.select(&sel(".ani a[href], a.ani[href]")) {
            let name = node
                .attr("title")
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| {
                    node.select(&img_sel)
                        .next()
                        .and_then(|i| i.attr("alt"))
                        .map(String::from)
                })
                .unwrap_or_else(|| node.text().collect::<String>().trim().to_string());
            consider(node.attr("href"), &name, title, &mut seen, &mut candidates);
        }
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates
    };

    if candidates.is_empty() {
        return Err(format!("\"{}\" not found on {}", title, label));
    }

    let mut last_error = "No matching series".to_string();
    // Walk ranked candidates; a show's seasons/spinoffs often split the episode
    // numbers, so the top title match may not carry the episode we need.
    for (url, score) in candidates.iter().take(4) {
        match resolve_episode(client, host, label, url, title, ep, mode).await {
            Ok(src) => return Ok(src),
            Err(e) => {
                last_error = trunc(&e, 90);
                // score 1000 = exact title match. Walking past it would hand
                // back a spin-off/season as if it were the requested show.
                if *score >= 1000 {
                    break;
                }
            }
        }
    }
    Err(last_error)
}

async fn resolve_episode(
    client: &reqwest::Client,
    host: &str,
    label: &str,
    watch_url: &str,
    title: &str,
    ep: &str,
    mode: &str,
) -> Result<AnikotoSource, String> {
    let absolute = if watch_url.starts_with("http") {
        watch_url.to_string()
    } else {
        format!("{}{}", host, watch_url)
    };
    // watchUrl comes from upstream search-result hrefs — a poisoned result
    // could point anywhere (internal network). Same gate as the media proxies.
    if watch_url.starts_with("http") && !is_safe_url(watch_url).await {
        return Err("Blocked unsafe watch URL".into());
    }

    // 2. Watch page -> data-id
    let watch_body = get_text(client, &absolute, 8000).await?;
    let data_id = RE_DATA_ID
        .captures(&watch_body)
        .map(|c| c[1].to_string())
        .ok_or("Could not resolve anime ID")?;

    // 3. Episode list -> target episode's server payload
    let ep_body = get_text(client, &format!("{}/ajax/episode/list/{}", host, data_id), 8000).await?;
    let ep_html = serde_json::from_str::<Value>(&ep_body)
        .ok()
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(String::from))
        .unwrap_or_default();
    let ep_data_ids = {
        let ep_doc = Html::parse_document(&ep_html);
        let target = ep_doc
            .select(&sel(&format!("a[data-num=\"{}\"]", ep)))
            .next()
            .ok_or_else(|| format!("Episode {} not found", ep))?;
        // data-sub / data-dub tell us up front whether this episode has the
        // requested audio.
        if mode == "dub" && target.attr("data-dub") == Some("0") {
            return Err(format!("Episode {} has no dub on {}", ep, label));
        }
        if mode == "sub" && target.attr("data-sub") == Some("0") {
            return Err(format!("Episode {} has no sub on {}", ep, label));
        }
        let ids = target
            .attr("data-ids")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("Episode {} not found", ep))?;
        // Drop non-Send parse state before returning.
        let _ = target;
        ids
    };

    // 4. Server list, restricted to the requested audio type
    let srv_body = get_text(
        client,
        &format!("{}/ajax/server/list?servers={}", host, ep_data_ids),
        8000,
    )
    .await?;
    let srv_html = serde_json::from_str::<Value>(&srv_body)
        .ok()
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(String::from))
        .unwrap_or_default();
    let (jobs, verified) = {
        let srv_doc = Html::parse_document(&srv_html);

        // Servers live under div.type[data-type="sub"|"dub"]. When the response
        // declares types we must never fall back to the other variant.
        let mut server_nodes: Vec<ElementRef> = srv_doc
            .select(&sel(&format!("div.type[data-type=\"{}\"] li[data-link-id]", mode)))
            .collect();
        // Whether the audio variant was proven: only a data-type-scoped match proves
        // it. The untyped fallback (response carries no type info at all) does not.
        let verified = !server_nodes.is_empty();
        if server_nodes.is_empty()
            && srv_doc.select(&sel("div.type[data-type]")).next().is_none()
        {
            server_nodes = srv_doc.select(&sel("li[data-link-id]")).collect();
        }
        if server_nodes.is_empty() {
            return Err(format!("No {} servers for episode {}", mode, ep));
        }

        // Collect owned data first so no non-Send ElementRef survives an await.
        let jobs: Vec<(String, String)> = server_nodes
            .iter()
            .filter_map(|n| {
                let link_id = n.attr("data-link-id").filter(|s| !s.is_empty())?;
                Some((link_id.to_string(), n.text().collect::<String>().trim().to_string()))
            })
            .collect();
        (jobs, verified)
    };

    let mut last_error = "All servers failed".to_string();
    for (link_id, name) in jobs {
        match try_server(client, host, &link_id, &name, title, label, verified).await {
            Ok(Some(src)) => return Ok(src),
            Ok(None) => {}
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

// Returns Ok(None) for a silent skip (no embed URL / unsafe) and Err for a
// failure that should become the reported lastError.
async fn try_server(
    client: &reqwest::Client,
    host: &str,
    link_id: &str,
    name: &str,
    title: &str,
    label: &str,
    verified: bool,
) -> Result<Option<AnikotoSource>, String> {
    let server_url = format!("{}/ajax/server?get={}", host, link_id);
    let body = get_text(client, &server_url, 8000)
        .await
        .map_err(|e| format!("{}: {}", name, trunc(&e, 60)))?;
    let embed_url = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("result")
                .and_then(|r| r.get("url"))
                .and_then(|u| u.as_str())
                .map(String::from)
        });
    let embed_url = match embed_url {
        Some(u) if u.starts_with("http") => u,
        _ => return Ok(None),
    };
    // embedUrl is built from upstream-controlled data — SSRF gate before fetch.
    if !is_safe_url(&embed_url).await {
        return Ok(None);
    }

    // The player page itself is the real availability check — upstream embeds
    // answer 200 with an "Error Code:" body when a source has been taken down.
    let check = client
        .get(&embed_url)
        .header(reqwest::header::USER_AGENT, AGENT)
        .header("X-Requested-With", "XMLHttpRequest")
        .timeout(Duration::from_millis(5000))
        .send()
        .await
        .map_err(|e| format!("{}: {}", name, trunc(&e.to_string(), 60)))?;
    let status = check.status().as_u16();
    let page = check
        .text()
        .await
        .map_err(|e| format!("{}: {}", name, trunc(&e.to_string(), 60)))?;
    if status >= 400 || page.contains("Error Code:") {
        return Err(format!("{}: HTTP {}", name, status));
    }

    Ok(Some(AnikotoSource {
        embed_url,
        label: label.to_string(),
        server_label: name.to_string(),
        title: title.to_string(),
        // true only when the server was matched inside the data-type block for
        // this mode; the untyped fallback cannot promise dub.
        dub_capable: verified,
    }))
}

pub async fn get_anikoto_embeds(
    client: &reqwest::Client,
    title: &str,
    ep: &str,
    mode: &str,
) -> Result<Vec<Value>, String> {
    let key = format!("anikoto|{}|{}|{}", urlencoding::encode(title), ep, mode);
    if let Some(cached) = cache_get(&key) {
        return Ok(cached.as_array().cloned().unwrap_or_default());
    }

    // Mirrors are clones of one WordPress install and usually resolve to the
    // identical upstream player, so results are deduped by embed URL.
    let mirrors = get_mirrors();
    let futures = mirrors
        .iter()
        .map(|m| resolve_from_mirror(client, m, title, ep, mode));
    let settled: Vec<Option<AnikotoSource>> =
        futures::future::join_all(futures).await.into_iter().map(|r| r.ok()).collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut resolved: Vec<AnikotoSource> = Vec::new();
    let mut collapsed = false;
    for r in settled.into_iter().flatten() {
        if !seen.insert(r.embed_url.clone()) {
            collapsed = true;
            continue;
        }
        resolved.push(r);
    }

    // Several mirrors pointed at the same player — drop the mirror suffix so
    // the server button just reads "Anikoto <player>".
    if collapsed {
        for r in &mut resolved {
            r.label = "Anikoto".to_string();
        }
    }

    // Unique player pages usually expose a direct stream. Extraction runs once
    // per unique embed — mirrors share the same player, so it happens after
    // the dedupe above, not per mirror. On any failure the embed remains as
    // fallback.
    let mut results: Vec<Value> = Vec::new();
    for r in resolved {
        let extracted = extract_player_sources(client, &r.embed_url, "")
            .await
            .unwrap_or_default()
            .into_iter()
            .next();
        let player = extracted
            .as_ref()
            .and_then(|v| v.get("playerName"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let server_name = format!("{} {}", r.label, player.unwrap_or(&r.server_label)).trim().to_string();
        let mut obj = Map::new();
        obj.insert("embedUrl".into(), json!(r.embed_url));
        obj.insert("title".into(), json!(r.title));
        obj.insert("dubCapable".into(), json!(r.dub_capable));
        obj.insert("serverName".into(), json!(server_name));
        if let Some(ex) = extracted {
            if let Some(m) = ex.as_object() {
                for (k, v) in m {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        results.push(Value::Object(obj));
    }

    if !results.is_empty() {
        cache_set(key, json!(results));
    }
    Ok(results)
}
