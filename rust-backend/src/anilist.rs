// AniList GraphQL client (port of src/lib/anilist.ts). Owned by the anime
// migration — every consumer (titles/relations/search/schedule/random) lives
// in routes/anime_api.rs.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const ANILIST_URL: &str = "https://graphql.anilist.co";
const KITSU_MAP_URL: &str = "https://kitsu.io/api/edge/mappings";
const KITSU_ANIME_URL: &str = "https://kitsu.io/api/edge/anime";

const MEMO_MAX: usize = 100;
const THIRTY_MIN: Duration = Duration::from_secs(30 * 60);
const HOUR: Duration = Duration::from_secs(3600);
const SIX_HOURS: Duration = Duration::from_secs(6 * 3600);
const DAY_24: Duration = Duration::from_secs(24 * 3600);

// AniList is POSTed, bypassing any upstream cache — only successful responses
// are memoized so a Kitsu fallback never gets pinned for hours.
static MEMO: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn memo_get(key: &str, ttl: Duration) -> Option<Value> {
    let store = MEMO.lock().unwrap();
    store
        .get(key)
        .filter(|(ts, _)| ts.elapsed() < ttl)
        .map(|(_, v)| v.clone())
}

fn memo_set(key: &str, value: Value) {
    let mut store = MEMO.lock().unwrap();
    if store.len() >= MEMO_MAX {
        if let Some(oldest) = store.iter().min_by_key(|(_, v)| v.0).map(|(k, _)| k.clone()) {
            store.remove(&oldest);
        }
    }
    store.insert(key.to_string(), (Instant::now(), value));
}

// Matches TS replace(/<[^>]*>?/gm, ""): '<' through the next '>' (or end).
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '<' {
            for c2 in chars.by_ref() {
                if c2 == '>' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

async fn anilist_post(
    client: &reqwest::Client,
    query: &str,
    variables: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert("query".into(), json!(query));
    if !variables.is_null() {
        body.insert("variables".into(), variables.clone());
    }
    let res = client
        .post(ANILIST_URL)
        .header("Content-Type", "application/json")
        .json(&Value::Object(body))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("AniList {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

async fn kitsu_get(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<Value, String> {
    let res = client
        .get(url)
        .header("Accept", "application/vnd.api+json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Kitsu {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

// ── Search merge (finds upcoming/uncatalogued titles allanime doesn't have) ──

const ANI_SEARCH_QUERY: &str = "query($search: String) { Page(perPage: 20) { media(search: $search, type: ANIME, isAdult: false) { id title { romaji english } coverImage { large } status } } }";

pub async fn search_ani_list(client: &reqwest::Client, query: &str) -> Result<Vec<Value>, String> {
    let key = format!("ani:q:{}", query.trim().to_lowercase());
    if let Some(hit) = memo_get(&key, THIRTY_MIN) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    let j = anilist_post(
        client,
        ANI_SEARCH_QUERY,
        &json!({ "search": query }),
        Duration::from_secs(8),
    )
    .await?;
    let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = media.iter().map(search_row).collect();
    memo_set(&key, Value::Array(out.clone()));
    Ok(out)
}

fn search_row(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    o.insert("status".into(), json!(m["status"].as_str().unwrap_or("")));
    Value::Object(o)
}

// ── Relations (sequels/prequels/related) ──

const RELATIONS_QUERY: &str = r#"query($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: ANIME) {
    relations { edges { relationType node { id type title { romaji english } coverImage { large } } } }
  }
}"#;

// Only linkable anime relations: manga SOURCE/ADAPTATION entries would
// dead-end on the watch page, CHARACTER/SETTING/SUMMARY edges are noise.
const RELATION_FILTER: [&str; 6] = [
    "SEQUEL",
    "PREQUEL",
    "SIDE_STORY",
    "ALTERNATIVE",
    "SPIN_OFF",
    "PARENT",
];
const RELATION_ORDER: [&str; 6] = [
    "SEQUEL",
    "PREQUEL",
    "PARENT",
    "SIDE_STORY",
    "SPIN_OFF",
    "ALTERNATIVE",
];

pub async fn get_ani_relations(
    client: &reqwest::Client,
    id: Option<u64>,
    mal_id: Option<u64>,
) -> Result<Vec<Value>, String> {
    // Namespaced: AniList id 123 and MAL id 123 are different shows.
    let key = format!(
        "ani:rel:id:{}:mal:{}",
        id.map(|v| v.to_string()).unwrap_or_default(),
        mal_id.map(|v| v.to_string()).unwrap_or_default()
    );
    if let Some(hit) = memo_get(&key, DAY_24) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    // AniList treats an explicit `id: null` as a lookup that resolves to
    // nothing, so only include the variables actually provided.
    let mut vars = Map::new();
    if let Some(v) = id.filter(|v| *v > 0) {
        vars.insert("id".into(), json!(v));
    }
    if let Some(v) = mal_id.filter(|v| *v > 0) {
        vars.insert("idMal".into(), json!(v));
    }
    match fetch_relations(client, Value::Object(vars)).await {
        Ok(out) => {
            memo_set(&key, Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => Ok(vec![]),
    }
}

async fn fetch_relations(client: &reqwest::Client, vars: Value) -> Result<Vec<Value>, String> {
    let j = anilist_post(client, RELATIONS_QUERY, &vars, Duration::from_secs(8)).await?;
    let media = &j["data"]["Media"];
    if media.is_null() {
        return Err("AniList: media not found".into());
    }
    let edges = media["relations"]["edges"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<Value> = edges
        .iter()
        .filter(|e| {
            let rt = e["relationType"].as_str().unwrap_or("");
            RELATION_FILTER.contains(&rt) && e["node"]["type"].as_str() == Some("ANIME")
        })
        .map(|e| {
            let node = &e["node"];
            let english = node["title"]["english"].as_str().filter(|s| !s.is_empty());
            json!({
                "id": node["id"].as_i64().unwrap_or(0),
                "relation": e["relationType"].as_str().unwrap_or(""),
                "title": english.unwrap_or(node["title"]["romaji"].as_str().unwrap_or("")),
                "thumbnail": node["coverImage"]["large"].as_str().unwrap_or(""),
            })
        })
        .collect();
    out.sort_by_key(|v| {
        let rt = v["relation"].as_str().unwrap_or("");
        RELATION_ORDER
            .iter()
            .position(|r| *r == rt)
            .unwrap_or(RELATION_ORDER.len())
    });
    Ok(out)
}

// ── Schedule (replaces jikan getAnimeSchedule) ──

const SCHEDULE_QUERY: &str = "query($idMal: Int) { Media(idMal: $idMal, type: ANIME) { status nextAiringEpisode { airingAt episode } } }";

pub async fn get_anime_schedule(client: &reqwest::Client, mal_id: &str) -> Result<Value, String> {
    let memo_key = format!("sched:{}", mal_id);
    if let Some(hit) = memo_get(&memo_key, HOUR) {
        return Ok(hit);
    }
    let default = json!({ "broadcast": "", "status": "", "nextEpisode": Value::Null });
    let id: i64 = match mal_id.parse() {
        Ok(v) => v,
        // TS Number(malId) -> NaN -> serialized null -> Media resolves nothing.
        Err(_) => return Ok(default),
    };
    let j = match anilist_post(
        client,
        SCHEDULE_QUERY,
        &json!({ "idMal": id }),
        Duration::from_secs(8),
    )
    .await
    {
        Ok(j) => j,
        Err(_) => return Ok(default),
    };
    let media = &j["data"]["Media"];
    if media.is_null() {
        return Ok(default);
    }
    let next = &media["nextAiringEpisode"];
    let out = json!({
        "broadcast": "",
        "status": media["status"].as_str().unwrap_or(""),
        "nextEpisode": if next.is_null() {
            Value::Null
        } else {
            json!({ "episode": next["episode"].as_i64().unwrap_or(0), "title": "" })
        },
    });
    memo_set(&memo_key, out.clone());
    Ok(out)
}

// ── Episode titles (replaces jikan getEpisodeTitles via Kitsu) ──

async fn mal_to_kitsu_id(client: &reqwest::Client, mal_id: &str) -> Option<String> {
    let url = format!(
        "{}?filter[externalSite]=myanimelist/anime&filter[externalId]={}",
        KITSU_MAP_URL, mal_id
    );
    let j = kitsu_get(client, &url, Duration::from_secs(8)).await.ok()?;
    j["data"][0]["relationships"]["item"]["data"]["id"]
        .as_str()
        .map(String::from)
}

pub async fn get_episode_titles(client: &reqwest::Client, mal_id: &str) -> Result<Value, String> {
    // Mirrors Next's 1h fetch cache; empty results stay uncached so a Kitsu
    // outage isn't masked after it recovers.
    let memo_key = format!("titles:{}", mal_id);
    if let Some(hit) = memo_get(&memo_key, HOUR) {
        if hit.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            return Ok(hit);
        }
    }
    let mut titles: Map<String, Value> = Map::new();

    if let Some(kitsu_id) = mal_to_kitsu_id(client, mal_id).await {
        let mut offset: usize = 0;
        while offset < 500 {
            let url = format!(
                "{}/{}/episodes?page[limit]=20&page[offset]={}&sort=number",
                KITSU_ANIME_URL, kitsu_id, offset
            );
            let j = match kitsu_get(client, &url, Duration::from_secs(8)).await {
                Ok(j) => j,
                Err(_) => break,
            };
            let data = match j["data"].as_array() {
                Some(d) => d,
                None => break,
            };
            for ep in data {
                let attrs = &ep["attributes"];
                let name = attrs["canonicalTitle"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| attrs["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
                    .or_else(|| attrs["titles"]["en"].as_str().filter(|s| !s.is_empty()))
                    .unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let num = &attrs["number"];
                if let Some(n) = num.as_i64() {
                    titles.insert(n.to_string(), json!(name));
                } else if let Some(f) = num.as_f64() {
                    let s = if f.fract() == 0.0 {
                        format!("{}", f as i64)
                    } else {
                        format!("{}", f)
                    };
                    titles.insert(s, json!(name));
                }
            }
            if data.len() < 20 {
                break;
            }
            offset += 20;
        }
    }

    // Fallback: Jikan (MAL) episode list when Kitsu returned nothing.
    if titles.is_empty() {
        let mut page: usize = 1;
        while page <= 10 {
            let url = format!(
                "https://api.jikan.moe/v4/anime/{}/episodes?page={}",
                urlencoding::encode(mal_id),
                page
            );
            let j = match kitsu_get(client, &url, Duration::from_secs(8)).await {
                Ok(j) => j,
                Err(_) => break,
            };
            if let Some(data) = j["data"].as_array() {
                for ep in data {
                    let name = ep["title"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| ep["title_japanese"].as_str().filter(|s| !s.is_empty()))
                        .unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    if let Some(n) = ep["mal_id"].as_i64() {
                        titles.insert(n.to_string(), json!(name));
                    }
                }
            }
            if !j["pagination"]["has_next_page"].as_bool().unwrap_or(false) {
                break;
            }
            page += 1;
        }
    }

    let out = Value::Object(titles);
    if !out.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        memo_set(&memo_key, out.clone());
    }
    Ok(out)
}

// ── Trending & Popular (for homepage sections) ──

const TRENDING_POPULAR_QUERY: &str = "query($sort: [MediaSort]) { Page(perPage: 20) { media(sort: $sort, type: ANIME) { id idMal title { romaji english native } coverImage { large } trending popularity averageScore description status genres } } }";

fn score_of(v: &Value) -> Value {
    match v.as_f64() {
        Some(x) => json!(x.round() / 10.0),
        None => Value::Null,
    }
}

fn map_ani_media(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert(
        "malId".into(),
        json!(m["idMal"]
            .as_i64()
            .filter(|v| *v != 0)
            .map(|v| v.to_string())
            .unwrap_or_default()),
    );
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert("score".into(), score_of(&m["averageScore"]));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
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

fn map_kitsu_media(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    let name = en
        .or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
        .or_else(|| a["canonicalTitle"].as_str())
        .unwrap_or("");
    let mut o = Map::new();
    o.insert("_id".into(), json!(format!("kitsu-{}", d["id"].as_str().unwrap_or(""))));
    o.insert("name".into(), json!(name));
    if let Some(en) = en {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(a["posterImage"]["large"]
            .as_str()
            .or_else(|| a["posterImage"]["original"].as_str())
            .unwrap_or("")),
    );
    o.insert("score".into(), rating_score(&a["averageRating"]));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

async fn kitsu_media(
    client: &reqwest::Client,
    sort: &str,
    timeout: Duration,
) -> Result<Vec<Value>, String> {
    let url = format!("{}?page[limit]=20&sort={}", KITSU_ANIME_URL, sort);
    let j = kitsu_get(client, &url, timeout).await?;
    let data = j["data"].as_array().cloned().unwrap_or_default();
    Ok(data.iter().map(map_kitsu_media).collect())
}

async fn ani_trending_popular(client: &reqwest::Client, sort: &str) -> Result<Vec<Value>, String> {
    let j = anilist_post(
        client,
        TRENDING_POPULAR_QUERY,
        &json!({ "sort": [sort] }),
        Duration::from_secs(8),
    )
    .await?;
    let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
    Ok(media.iter().map(map_ani_media).collect())
}

pub async fn get_ani_trending(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:trending", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match ani_trending_popular(client, "TRENDING_DESC").await {
        Ok(out) => {
            memo_set("ani:trending", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => kitsu_media(client, "-favoritesCount", Duration::from_secs(8)).await,
    }
}

pub async fn get_ani_popular(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:popular", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match ani_trending_popular(client, "POPULARITY_DESC").await {
        Ok(out) => {
            memo_set("ani:popular", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => kitsu_media(client, "-userCount", Duration::from_secs(8)).await,
    }
}

const TOP_RATED_QUERY: &str = "query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false) { id idMal title { romaji english } coverImage { large } averageScore genres } } }";

fn top_row(a: &Value) -> Value {
    json!({
        "_id": a["id"].as_i64().unwrap_or(0).to_string(),
        "malId": a["idMal"].as_i64().filter(|v| *v != 0).map(|v| v.to_string()).unwrap_or_default(),
        "title": a["title"]["romaji"].as_str().unwrap_or(""),
        "englishName": a["title"]["english"].as_str().unwrap_or(""),
        "thumbnail": a["coverImage"]["large"].as_str().unwrap_or(""),
        "score": score_of(&a["averageScore"]),
        "genres": a["genres"].as_array().cloned().unwrap_or_default(),
    })
}

fn top_kitsu_row(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    json!({
        // kitsu- prefix: without it the fallback ids route as AniList ids.
        "_id": format!("kitsu-{}", d["id"].as_str().unwrap_or("")),
        "malId": "",
        "title": en.or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| a["canonicalTitle"].as_str()).unwrap_or(""),
        "englishName": a["titles"]["en"].as_str().unwrap_or(""),
        "thumbnail": a["posterImage"]["large"].as_str()
            .or_else(|| a["posterImage"]["original"].as_str()).unwrap_or(""),
        "score": rating_score(&a["averageRating"]),
        "genres": [],
    })
}

pub async fn get_ani_top_rated(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:top", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, TOP_RATED_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media.iter().map(top_row).collect();
            memo_set("ani:top", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => {
            let url = format!("{}?page[limit]=20&sort=ratingRank", KITSU_ANIME_URL);
            let j = kitsu_get(client, &url, Duration::from_secs(8)).await?;
            let data = j["data"].as_array().cloned().unwrap_or_default();
            Ok(data.iter().map(top_kitsu_row).collect())
        }
    }
}

// ── Hidden gems: highly rated but not widely watched (feeds /api/random) ──

const HIDDEN_GEMS_QUERY: &str = "query { Page(page: 1, perPage: 20) { media(sort: SCORE_DESC, type: ANIME, isAdult: false, averageScore_greater: 75, popularity_lesser: 60000) { id idMal title { romaji english } coverImage { large } averageScore genres } } }";

pub async fn get_ani_hidden_gems(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:gems", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, HIDDEN_GEMS_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media
                .iter()
                .map(|a| {
                    json!({
                        "_id": a["id"].as_i64().unwrap_or(0).to_string(),
                        "malId": a["idMal"].as_i64().filter(|v| *v != 0)
                            .map(|v| v.to_string()).unwrap_or_default(),
                        "score": score_of(&a["averageScore"]),
                    })
                })
                .collect();
            memo_set("ani:gems", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => Ok(vec![]),
    }
}

// ── Spotlight (ongoing/new anime with descriptions) ──

const SPOTLIGHT_QUERY: &str = "query { Page(page: 1, perPage: 10) { media(status: RELEASING, type: ANIME, isAdult: false, sort: UPDATED_AT_DESC) { id idMal title { romaji english native } coverImage { large } trending popularity averageScore description status genres } } }";

fn spotlight_row(m: &Value) -> Value {
    let english = m["title"]["english"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(m["id"].as_i64().unwrap_or(0).to_string()));
    o.insert(
        "name".into(),
        json!(english.unwrap_or(m["title"]["romaji"].as_str().unwrap_or(""))),
    );
    if let Some(en) = english {
        o.insert("englishName".into(), json!(en));
    }
    o.insert(
        "malId".into(),
        json!(m["idMal"]
            .as_i64()
            .filter(|v| *v != 0)
            .map(|v| v.to_string())
            .unwrap_or_default()),
    );
    o.insert(
        "thumbnail".into(),
        json!(m["coverImage"]["large"].as_str().unwrap_or("")),
    );
    o.insert(
        "description".into(),
        json!(strip_html(m["description"].as_str().unwrap_or(""))),
    );
    o.insert(
        "genres".into(),
        json!(m["genres"].as_array().cloned().unwrap_or_default()),
    );
    o.insert("status".into(), json!(m["status"].as_str().unwrap_or("")));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

fn kitsu_spotlight_row(d: &Value) -> Value {
    let a = &d["attributes"];
    let en = a["titles"]["en"].as_str().filter(|s| !s.is_empty());
    let mut o = Map::new();
    o.insert("_id".into(), json!(format!("kitsu-{}", d["id"].as_str().unwrap_or(""))));
    o.insert(
        "name".into(),
        json!(en.or_else(|| a["titles"]["en_jp"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| a["canonicalTitle"].as_str())
            .unwrap_or("")),
    );
    if let Some(en) = en {
        o.insert("englishName".into(), json!(en));
    }
    o.insert("malId".into(), json!(""));
    o.insert(
        "thumbnail".into(),
        json!(a["posterImage"]["large"]
            .as_str()
            .or_else(|| a["posterImage"]["original"].as_str())
            .unwrap_or("")),
    );
    o.insert(
        "description".into(),
        json!(strip_html(a["synopsis"].as_str().unwrap_or(""))),
    );
    o.insert("genres".into(), json!([]));
    o.insert("status".into(), json!("RELEASING"));
    o.insert("availableEpisodes".into(), json!({ "sub": 0, "dub": 0 }));
    Value::Object(o)
}

pub async fn get_ani_spotlight(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    if let Some(hit) = memo_get("ani:spotlight", SIX_HOURS) {
        if let Some(arr) = hit.as_array() {
            return Ok(arr.clone());
        }
    }
    match anilist_post(client, SPOTLIGHT_QUERY, &Value::Null, Duration::from_secs(8)).await {
        Ok(j) => {
            let media = j["data"]["Page"]["media"].as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = media.iter().map(spotlight_row).collect();
            memo_set("ani:spotlight", Value::Array(out.clone()));
            Ok(out)
        }
        Err(_) => {
            // AniList down — use Kitsu ongoing anime.
            let url = format!(
                "{}?filter[status]=current&page[limit]=10&sort=-favoritesCount",
                KITSU_ANIME_URL
            );
            match kitsu_get(client, &url, Duration::from_secs(8)).await {
                Ok(j) => {
                    let data = j["data"].as_array().cloned().unwrap_or_default();
                    Ok(data.iter().map(kitsu_spotlight_row).collect())
                }
                Err(_) => Ok(vec![]),
            }
        }
    }
}

// ── Weekly airing window (feeds /api/schedule) ──

const AIRING_QUERY: &str = "query ($start: Int, $end: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) { airingAt media { idMal title { romaji english } coverImage { large } averageScore genres } } } }";

pub async fn fetch_airing_schedules(
    client: &reqwest::Client,
    start: i64,
    end: i64,
) -> Result<Vec<Value>, String> {
    let mut all: Vec<Value> = Vec::new();
    let mut page: i64 = 1;
    let mut has_next = true;
    while has_next && page <= 10 {
        let j = anilist_post(
            client,
            AIRING_QUERY,
            &json!({ "start": start, "end": end, "page": page }),
            Duration::from_secs(10),
        )
        .await?;
        if let Some(arr) = j["data"]["Page"]["airingSchedules"].as_array() {
            all.extend(arr.iter().cloned());
        }
        has_next = j["data"]["Page"]["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false);
        page += 1;
    }
    Ok(all)
}

/// Currently airing Kitsu anime (raw `data` rows) for the schedule fallback.
pub async fn fetch_kitsu_current(client: &reqwest::Client) -> Result<Vec<Value>, String> {
    let url = format!("{}?filter[status]=current&page[limit]=20&sort=-favoritesCount", KITSU_ANIME_URL);
    let j = kitsu_get(client, &url, Duration::from_secs(10)).await?;
    Ok(j["data"].as_array().cloned().unwrap_or_default())
}
