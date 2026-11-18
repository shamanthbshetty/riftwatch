// AllAnime GraphQL client (search/show resolution, port of src/lib/allanime.ts).
// Owned by the anime migration. NOTE: routes/episodes.rs has its own private
// copy of this plumbing — do not touch that file.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::config::{env_str, normalize_base};

use futures::StreamExt;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";
const ANILIST_URL: &str = "https://graphql.anilist.co";

const SEARCH_TTL: Duration = Duration::from_secs(30 * 60);
const SHOW_TTL: Duration = Duration::from_secs(30 * 60);
const TITLE_TTL: Duration = Duration::from_secs(60 * 60);
const SEARCH_CACHE_MAX: usize = 100;
const SHOW_CACHE_MAX: usize = 200;
const TITLE_CACHE_MAX: usize = 1000;

// Lookups are capped + bounded-parallel: 40 sequential AniList/Kitsu lookups
// made every search take 12-40 s, all at once burns the rate limit.
const TITLE_LOOKUP_CONCURRENCY: usize = 8;
const TITLE_LOOKUP_LIMIT: usize = 0;

#[derive(Clone)]
pub struct ShowName {
    pub name: String,
    pub english_name: Option<String>,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .user_agent(AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("allanime client")
    });
    &CLIENT
}

struct Timed<V> {
    ts: Instant,
    value: V,
}

fn evict<V>(map: &mut HashMap<String, Timed<V>>, max: usize, ttl: Duration) {
    let now = Instant::now();
    map.retain(|_, v| now.saturating_duration_since(v.ts) < ttl);
    while map.len() >= max {
        match map.iter().min_by_key(|(_, v)| v.ts).map(|(k, _)| k.clone()) {
            Some(k) => {
                map.remove(&k);
            }
            None => break,
        }
    }
}

static SEARCH_CACHE: LazyLock<Mutex<HashMap<String, Timed<Vec<Value>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SHOW_CACHE: LazyLock<Mutex<HashMap<String, Timed<Option<ShowName>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TITLE_CACHE: LazyLock<Mutex<HashMap<String, Timed<Option<String>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Primary frontend mirror + backend API host are env-overridable so a domain
// seizure is a config change instead of a source edit.
fn get_referer() -> String {
    let mirror = env_str("ALLANIME_MIRROR", "mkissa.to");
    let m = mirror
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    format!("https://{}", if m.is_empty() { "mkissa.to" } else { m })
}

fn get_api_bases() -> Vec<String> {
    let backend = env_str("ALLANIME_BACKEND", "mkissa.net");
    let backend = backend
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let backend = if backend.is_empty() { "mkissa.net" } else { backend };
    let mut bases = vec![format!("https://api.{}", backend)];
    // ALLANIME_FALLBACK_MIRRORS="allanime.day|api.allanime.day, ..." — each
    // entry is "page|backend" (backend half becomes the api host) or a full
    // backend/api URL used as-is.
    let raw = std::env::var("ALLANIME_FALLBACK_MIRRORS").unwrap_or_default();
    for entry in raw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let half = if entry.contains('|') {
            entry.split('|').nth(1).unwrap_or(entry).trim()
        } else {
            entry
        };
        if half.is_empty() {
            continue;
        }
        let base = if half.starts_with("http://") || half.starts_with("https://") {
            normalize_base(half)
        } else if half.starts_with("api.") {
            format!("https://{}", normalize_base(half))
        } else {
            format!(
                "https://api.{}",
                normalize_base(half.trim_start_matches("https://").trim_start_matches("http://"))
            )
        };
        if !bases.contains(&base) {
            bases.push(base);
        }
    }
    bases
}

// ALLANIME_PROXY=https://host/?url=$URL wraps the target; a CONNECT-tunnel
// proxy cannot be driven without an agent — ignored, direct is tried.
fn apply_proxy(target: &str) -> String {
    let proxy = env_str("ALLANIME_PROXY", "");
    if proxy.is_empty() {
        return target.to_string();
    }
    if proxy.contains("$URL") {
        return proxy.replace("$URL", &urlencoding::encode(target));
    }
    if proxy.contains('@') {
        return target.to_string();
    }
    static TUNNEL: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^http://[^/]*:\d+/?$").unwrap());
    if TUNNEL.is_match(&proxy) {
        return target.to_string();
    }
    format!("{}/{}", proxy.trim_end_matches('/'), target)
}

async fn gql(query: &str, variables: Value) -> Result<Value, String> {
    let bases = get_api_bases();
    let referer = get_referer();
    let mut last: Option<String> = None;
    for base in &bases {
        let url = apply_proxy(&format!("{}/api", base));
        let body = json!({ "query": query, "variables": variables });
        match http()
            .post(&url)
            .header("Content-Type", "application/json")
            .header("User-Agent", AGENT)
            .header("Referer", &referer)
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(res) => {
                if !res.status().is_success() {
                    last = Some(format!("Allanime {}", res.status()));
                    continue;
                }
                match res.json::<Value>().await {
                    Ok(j) => {
                        if let Some(errs) = j.get("errors").and_then(|e| e.as_array()) {
                            if !errs.is_empty() {
                                last = Some(
                                    errs.iter()
                                        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                                        .collect::<Vec<_>>()
                                        .join(", "),
                                );
                                continue;
                            }
                        }
                        match j.get("data") {
                            Some(d) if !d.is_null() => return Ok(d.clone()),
                            _ => {
                                last = Some("Allanime: response missing data".into());
                            }
                        }
                    }
                    Err(e) => last = Some(e.to_string()),
                }
            }
            Err(e) => last = Some(e.to_string()),
        }
    }
    Err(last.unwrap_or_else(|| format!("Allanime unreachable ({})", bases.join(", "))))
}

const SEARCH_GQL: &str = r#"query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) {
  shows(search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin) {
    edges { _id name englishName nativeName thumbnail availableEpisodes __typename }
  }
}"#;

const SHOW_GQL: &str = r#"query($showId: String!) {
  show(_id: $showId) {
    _id name englishName nativeName thumbnail description status
    availableEpisodesDetail
  }
}"#;

// Cache misses too ("no english title found") — otherwise every search
// re-fires two upstream lookups for every unresolved title, every time.
async fn resolve_english_title(name: &str) -> Option<String> {
    {
        let cache = TITLE_CACHE.lock().unwrap();
        if let Some(hit) = cache.get(name) {
            if hit.ts.elapsed() < TITLE_TTL {
                return hit.value.clone();
            }
        }
    }

    let mut found: Option<String> = None;
    let body = json!({
        "query": "query($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME) { title { english romaji } } } }",
        "variables": { "search": name }
    });
    if let Ok(res) = http()
        .post(ANILIST_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(j) = res.json::<Value>().await {
                if let Some(en) = j["data"]["Page"]["media"][0]["title"]["english"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                {
                    found = Some(en.to_string());
                }
            }
        }
    }

    if found.is_none() {
        let url = format!(
            "https://kitsu.io/api/edge/anime?filter[text]={}&page[limit]=1",
            urlencoding::encode(name)
        );
        if let Ok(res) = http()
            .get(&url)
            .header("Accept", "application/vnd.api+json")
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(j) = res.json::<Value>().await {
                    if let Some(en) = j["data"][0]["attributes"]["titles"]["en"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                    {
                        found = Some(en.to_string());
                    }
                }
            }
        }
    }

    let mut cache = TITLE_CACHE.lock().unwrap();
    evict(&mut cache, TITLE_CACHE_MAX, TITLE_TTL);
    cache.insert(
        name.to_string(),
        Timed {
            ts: Instant::now(),
            value: found.clone(),
        },
    );
    found
}

fn parse_count(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(0)),
        Value::String(s) => {
            let t = s.trim_start();
            let (neg, rest) = match t.strip_prefix('-') {
                Some(r) => (true, r),
                None => (false, t),
            };
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            match digits.parse::<i64>() {
                Ok(n) => {
                    if neg {
                        -n
                    } else {
                        n
                    }
                }
                Err(_) => 0,
            }
        }
        _ => 0,
    }
}

/// AllAnime title search — rows carry episode counts.
pub async fn search_anime(query: &str) -> Result<Vec<Value>, String> {
    let key = query.trim().to_lowercase();
    {
        let cache = SEARCH_CACHE.lock().unwrap();
        if let Some(hit) = cache.get(&key) {
            if hit.ts.elapsed() < SEARCH_TTL {
                return Ok(hit.value.clone());
            }
        }
    }

    let vars = json!({
        "search": { "allowAdult": false, "allowUnknown": false, "query": query },
        "limit": 40,
        "page": 1,
        "translationType": "sub",
        "countryOrigin": "ALL"
    });
    let data = gql(SEARCH_GQL, vars).await?;
    let edges = data
        .get("shows")
        .and_then(|s| s.get("edges"))
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    // Only rows missing englishName need a lookup, only the first
    // TITLE_LOOKUP_LIMIT of those, with bounded parallelism.
    let mut needs: Vec<usize> = Vec::new();
    for (i, s) in edges.iter().enumerate() {
        if needs.len() >= TITLE_LOOKUP_LIMIT {
            break;
        }
        if s.get("englishName").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            needs.push(i);
        }
    }
    let edges_ref: &Vec<Value> = &edges;
    let resolved: Vec<Option<String>> = futures::stream::iter(needs.iter().copied())
        .map(|i| async move {
            resolve_english_title(edges_ref[i]["name"].as_str().unwrap_or("")).await
        })
        .buffered(TITLE_LOOKUP_CONCURRENCY)
        .collect()
        .await;
    let mut resolved_map: HashMap<usize, Option<String>> = HashMap::new();
    for (j, i) in needs.iter().enumerate() {
        resolved_map.insert(*i, resolved[j].clone());
    }

    let mut out: Vec<Value> = Vec::with_capacity(edges.len());
    for (i, s) in edges.iter().enumerate() {
        let english = s
            .get("englishName")
            .and_then(|v| v.as_str())
            .filter(|x| !x.is_empty());
        let name = match english {
            Some(en) => en.to_string(),
            None => match resolved_map.get(&i).cloned().flatten() {
                Some(en) if !en.is_empty() => en,
                _ => s["name"].as_str().unwrap_or("").to_string(),
            },
        };
        let mut row = Map::new();
        row.insert("_id".into(), json!(s["_id"].as_str().unwrap_or("")));
        row.insert("name".into(), json!(name));
        if let Some(en) = english {
            row.insert("englishName".into(), json!(en));
        }
        row.insert("malId".into(), json!(""));
        row.insert("thumbnail".into(), json!(s["thumbnail"].as_str().unwrap_or("")));
        row.insert(
            "availableEpisodes".into(),
            json!({
                "sub": parse_count(&s["availableEpisodes"]["sub"]),
                "dub": parse_count(&s["availableEpisodes"]["dub"]),
            }),
        );
        out.push(Value::Object(row));
    }

    let mut cache = SEARCH_CACHE.lock().unwrap();
    evict(&mut cache, SEARCH_CACHE_MAX, SEARCH_TTL);
    cache.insert(
        key,
        Timed {
            ts: Instant::now(),
            value: out.clone(),
        },
    );
    Ok(out)
}

async fn fetch_show(id: &str) -> Result<Option<ShowName>, String> {
    let data = gql(SHOW_GQL, json!({ "showId": id })).await?;
    let s = data.get("show").cloned().unwrap_or(Value::Null);
    if s.is_null() {
        return Ok(None);
    }
    let english = s
        .get("englishName")
        .and_then(|v| v.as_str())
        .filter(|x| !x.is_empty());
    let raw = match english {
        Some(en) => en.to_string(),
        None => s["name"].as_str().unwrap_or("").to_string(),
    };
    let name = match english {
        Some(_) => raw,
        None => match resolve_english_title(s["name"].as_str().unwrap_or("")).await {
            Some(en) if !en.is_empty() => en,
            _ => raw,
        },
    };
    Ok(Some(ShowName {
        name,
        english_name: english.map(String::from),
    }))
}

/// Resolve an AllAnime show id to its display name.
pub async fn get_show(id: &str) -> Result<ShowName, String> {
    {
        let cache = SHOW_CACHE.lock().unwrap();
        if let Some(hit) = cache.get(id) {
            if hit.ts.elapsed() < SHOW_TTL {
                return match &hit.value {
                    Some(s) => Ok(s.clone()),
                    None => Err("show not found".into()),
                };
            }
        }
    }

    // Retries mirror getShow(showId, retries = 2); throws are never cached so
    // an outage isn't remembered for 30 min.
    let mut last = String::new();
    for attempt in 0..3u8 {
        match fetch_show(id).await {
            Ok(show) => {
                let mut cache = SHOW_CACHE.lock().unwrap();
                evict(&mut cache, SHOW_CACHE_MAX, SHOW_TTL);
                cache.insert(
                    id.to_string(),
                    Timed {
                        ts: Instant::now(),
                        value: show.clone(),
                    },
                );
                return match show {
                    Some(s) => Ok(s),
                    None => Err("show not found".into()),
                };
            }
            Err(e) => {
                last = e;
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
    Err(format!("Failed to fetch show: Error: {}", last))
}
