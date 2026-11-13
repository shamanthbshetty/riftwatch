// Movie stream providers — VidSrc embeds + VidLink JSON API
// (port of src/lib/movie-providers.ts). Owned by the movies migration.

use serde_json::{json, Value};
use std::time::Duration;

use crate::config;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// encodeURIComponent leaves alphanumerics and `-_.!~*'()` alone.
const COMPONENT_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn encode_component(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, COMPONENT_SET).to_string()
}

#[derive(Default)]
struct VidLink {
    stream_url: Option<String>,
    subtitles: Vec<Value>,
}

async fn get_vidlink_stream(
    client: &reqwest::Client,
    tmdb_id: u32,
    media_type: &str,
    season: Option<i64>,
    episode: Option<i64>,
) -> VidLink {
    let path = if media_type == "tv" {
        format!("tv/{}/{}/{}", tmdb_id, season.unwrap_or(0), episode.unwrap_or(0))
    } else {
        format!("movie/{}", tmdb_id)
    };
    let key = config::env_str("VIDLINK_KEY", "");
    let key_q = if key.is_empty() {
        String::new()
    } else {
        format!("?key={}", key)
    };
    let url = format!("https://vidlink.pro/{}{}", path, key_q);

    // Don't let a slow upstream block the whole page.
    let res = match client
        .get(&url)
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return VidLink::default(),
    };
    let data = match res.json::<Value>().await {
        Ok(d) => d,
        Err(_) => return VidLink::default(),
    };

    let sources = data
        .get("sources")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    let m3u8 = sources
        .iter()
        .find(|s| {
            s["isM3U8"].as_bool() == Some(true) || s["url"].as_str().unwrap_or("").contains(".m3u8")
        })
        .or_else(|| sources.first());
    let stream_url = m3u8
        .and_then(|s| s["url"].as_str())
        .filter(|u| !u.is_empty())
        .map(String::from);

    let subtitles = data
        .get("subtitles")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|s| matches!(s["url"].as_str(), Some(u) if !u.is_empty()))
        .map(|s| {
            let label = s["name"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| s["lang"].as_str().filter(|v| !v.is_empty()))
                .unwrap_or("Subtitles");
            let lang = s["lang"].as_str().filter(|v| !v.is_empty()).unwrap_or("en");
            json!({
                "label": label,
                "url": format!(
                    "/api/movies/subtitle-proxy?url={}",
                    encode_component(s["url"].as_str().unwrap_or_default())
                ),
                "srclang": lang.chars().take(2).collect::<String>().to_lowercase(),
            })
        })
        .collect();

    VidLink { stream_url, subtitles }
}

/// Returns `{ "sources": [...], "subtitles": [...] }` in the same shape the
/// TS `getMovieStream` produced.
pub async fn get_movie_stream(
    client: &reqwest::Client,
    tmdb_id: u32,
    media_type: &str,
    season: Option<i64>,
    episode: Option<i64>,
) -> Result<Value, String> {
    let mut sources: Vec<Value> = Vec::new();
    let mut subtitles: Vec<Value> = Vec::new();

    // Direct HLS stream (carries embedded + external subtitles). Tried first so
    // the in-app subtitle menu is usable; iframe embeds are kept as fallback.
    // VidLink's JSON API needs a registered key — without one it 403s, so the
    // call is skipped entirely unless configured.
    if !config::env_str("VIDLINK_KEY", "").is_empty() {
        let vidlink = get_vidlink_stream(client, tmdb_id, media_type, season, episode).await;
        if let Some(stream_url) = vidlink.stream_url {
            sources.push(json!({
                "name": "VidLink",
                "streamUrl": format!(
                    "/api/movies/m3u8-proxy?url={}",
                    encode_component(&stream_url)
                ),
                "source": "vidlink",
            }));
            if !vidlink.subtitles.is_empty() {
                subtitles.extend(vidlink.subtitles);
            }
        }
    }

    // Official VidSrc domains + mirrors — kept as separate entries so one
    // domain dying doesn't take the whole provider down.
    // Override without editing source:
    //   VIDSRC_DOMAINS=https://vidsrc.sh,https://vidsrc2.ru,https://new-mirror.to
    let domains = config::env_list(
        "VIDSRC_DOMAINS",
        &[
            "https://vidsrc.sh",
            "https://vidsrc2.ru",
            "https://vidsrc.ir",
            "https://vsembed.su",
        ],
    );
    for domain in &domains {
        let host = url::Url::parse(domain)
            .ok()
            .and_then(|u| u.host_str().map(String::from))
            .unwrap_or_else(|| domain.clone());
        let name = match host.as_str() {
            "vidsrc.sh" => "VidSrc".to_string(),
            "vidsrc2.ru" => "VidSrc Mirror".to_string(),
            "vidsrc.ir" => "VidSrc IR".to_string(),
            "vsembed.su" => "Vsembed".to_string(),
            _ => format!("VidSrc {}", host),
        };
        let mut source: String = host
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        if source.is_empty() {
            source = "vidsrc".to_string();
        }
        let path = if media_type == "tv" {
            format!("/embed/tv/{}/{}/{}", tmdb_id, season.unwrap_or(0), episode.unwrap_or(0))
        } else {
            format!("/embed/movie/{}", tmdb_id)
        };
        sources.push(json!({
            "name": name,
            "embedUrl": format!("{}{}", domain, path),
            "source": source,
            "isEmbed": true,
        }));
    }

    Ok(json!({ "sources": sources, "subtitles": subtitles }))
}
