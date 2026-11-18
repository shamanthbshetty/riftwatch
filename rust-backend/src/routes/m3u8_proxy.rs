use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    body::Body,
};
use serde::Deserialize;
use std::time::Duration;
use crate::AppState;
use bytes::Bytes;

#[derive(Deserialize)]
pub struct ProxyQuery {
    pub url: String,
    pub referer: Option<String>,
    pub origin: Option<String>,
}

const DEFAULT_REFERER: &str = "https://megaplay.buzz/";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_ATTEMPTS: u32 = 2;
const HEAD_TARGET_BYTES: usize = 512;
const KEY_BODY_MAX_BYTES: usize = 1_000_000;

pub async fn handler(
    State(state): State<AppState>,
    Query(q): Query<ProxyQuery>,
) -> Response {
    if q.url.is_empty() {
        return (StatusCode::BAD_REQUEST, "url required").into_response();
    }
    if !is_safe_url(&q.url).await {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let referer = q.referer.clone().unwrap_or_else(|| DEFAULT_REFERER.to_string());
    let origin = q.origin.clone().unwrap_or_else(|| origin_of(&referer).unwrap_or_else(|| origin_of(&q.url).unwrap_or_default()));

    let headers = || {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::USER_AGENT, UA.parse().unwrap());
        h.insert(reqwest::header::ORIGIN, origin.parse().unwrap_or_else(|_| " ".parse().unwrap()));
        h.insert(reqwest::header::REFERER, referer.parse().unwrap_or_else(|_| " ".parse().unwrap()));
        h
    };

    let mut last_err: Option<String> = None;
    let mut sniff_bytes: Option<bytes::Bytes> = None;
    let mut content_type = String::new();

    for attempt in 0..MAX_ATTEMPTS {
        match state.http.get(&q.url).headers(headers()).send().await {
            Ok(res) => {
                if !res.status().is_success() {
                    if res.status().as_u16() < 500 || attempt == MAX_ATTEMPTS - 1 {
                        return (StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                                format!("upstream {}", res.status())).into_response();
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                content_type = res.headers().get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                match res.bytes().await {
                    Ok(b) => { sniff_bytes = Some(b); }
                    Err(e) => {
                        last_err = Some(e.to_string());
                        if attempt < MAX_ATTEMPTS - 1 { tokio::time::sleep(Duration::from_millis(500*(attempt as u64+1))).await; continue; }
                        return (StatusCode::BAD_GATEWAY, "m3u8-proxy error").into_response();
                    }
                }
                break;
            }
            Err(e) => {
                last_err = Some(e.to_string());
                if attempt < MAX_ATTEMPTS - 1 {
                    tokio::time::sleep(Duration::from_millis(500*(attempt as u64+1))).await;
                }
            }
        }
    }

    let mut body = match sniff_bytes {
        Some(b) => b,
        None => return (StatusCode::BAD_GATEWAY, format!("m3u8-proxy error: {}", last_err.unwrap_or_default())).into_response(),
    };

    let head_len = body.len().min(HEAD_TARGET_BYTES);
    let head = &body[..head_len];
    let latin_head = String::from_utf8_lossy(head);
    let manifest_ct = content_type.to_lowercase().contains("mpegurl") || content_type.to_lowercase().contains("dash+xml");

    let mut mode = classify(&body, &latin_head, manifest_ct, body.len() <= KEY_BODY_MAX_BYTES);

    if mode == Mode::Reject {
        if let Ok(res) = state.http.get(&q.url).headers(headers()).send().await {
            if res.status().is_success() {
                if let Ok(b) = res.bytes().await {
                    let rh = String::from_utf8_lossy(&b[..b.len().min(1024)]);
                    if !looks_like_error_text(&rh) || rh.contains("#EXTM3U") {
                        body = b;
                        let lh = String::from_utf8_lossy(&body[..body.len().min(1024)]);
                        if lh.contains("#EXTM3U") || manifest_ct { mode = Mode::Playlist; }
                        else { mode = Mode::Segment; }
                    }
                }
            }
        }
    }
    if mode == Mode::Reject {
        return (StatusCode::BAD_GATEWAY, "upstream returned an error page instead of media").into_response();
    }

    if mode == Mode::Playlist {
        let text = String::from_utf8_lossy(&body).to_string();
        let rewritten = rewrite_urls(&text, &q.url, &referer, &origin);
        let mut resp = Response::new(Body::from(rewritten));
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert("content-type", content_type.parse().unwrap_or("application/vnd.apple.mpegurl".parse().unwrap()));
        resp.headers_mut().insert("access-control-allow-origin", "*".parse().unwrap());
        resp.headers_mut().insert("cache-control", "public, max-age=120".parse().unwrap());
        return resp;
    }

    let ct = if content_type.to_lowercase().starts_with("video/") || content_type.to_lowercase().starts_with("audio/") {
        content_type.clone()
    } else {
        "video/mp2t".to_string()
    };
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert("content-type", ct.parse().unwrap_or("video/mp2t".parse().unwrap()));
    resp.headers_mut().insert("access-control-allow-origin", "*".parse().unwrap());
    resp.headers_mut().insert("cache-control", "public, max-age=86400".parse().unwrap());
    resp
}

#[derive(PartialEq)]
enum Mode { Playlist, Segment, Reject }

fn classify(body: &Bytes, latin_head: &str, manifest_ct: bool, tiny: bool) -> Mode {
    if tiny && !manifest_ct { return Mode::Segment; }
    if latin_head.contains("#EXTM3U") { return Mode::Playlist; }
    if is_ts(body) || is_mp4_box(body) { return Mode::Segment; }
    if looks_like_error_text(latin_head) && !manifest_ct { return Mode::Reject; }
    if manifest_ct { return Mode::Playlist; }
    Mode::Segment
}

fn is_ts(b: &Bytes) -> bool {
    if b.is_empty() || b[0] != 0x47 { return false; }
    if b.len() < 188 { return true; }
    if b[188] != 0x47 { return false; }
    b.len() < 376 || b[376] == 0x47
}

fn is_mp4_box(b: &Bytes) -> bool {
    if b.len() < 12 { return false; }
    let bx = &b[4..8];
    let s = String::from_utf8_lossy(bx);
    matches!(s.as_ref(), "ftyp" | "styp" | "moof" | "mdat" | "moov" | "sidx" | "emsg" | "prft" | "free" | "skip")
}

fn looks_like_error_text(head: &str) -> bool {
    let t = head.trim_start();
    t.starts_with('<') || t.starts_with('{') || t.starts_with('[')
        || t.to_lowercase().starts_with("error")
        || t.to_lowercase().starts_with("message")
        || t.to_lowercase().starts_with("status")
}

fn origin_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or("")))
}

async fn is_safe_url(url: &str) -> bool {
    if !url.starts_with("http://") && !url.starts_with("https://") { return false; }
    true
}

fn rewrite_urls(m3u8: &str, base_url: &str, referer: &str, origin: &str) -> String {
    let base = if base_url.ends_with('/') { base_url.to_string() } else {
        let i = base_url.rfind('/').map(|x| x + 1).unwrap_or(base_url.len());
        base_url[..i].to_string()
    };
    let proxied = |target: &str| -> String {
        format!("/api/movies/m3u8-proxy?url={}&referer={}&origin={}",
            urlencoding::encode(target), urlencoding::encode(referer), urlencoding::encode(origin))
    };
    let resolve = |trimmed: &str| -> String {
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") { return trimmed.to_string(); }
        if trimmed.starts_with("//") {
            if let Ok(u) = url::Url::parse(base_url) { return format!("{}:{}", u.scheme(), trimmed); }
            return trimmed.to_string();
        }
        if trimmed.starts_with('/') {
            if let Ok(u) = url::Url::parse(base_url) {
                return format!("{}://{}{}", u.scheme(), u.host_str().unwrap_or(""), trimmed);
            }
            return trimmed.to_string();
        }
        format!("{}{}", base, trimmed)
    };

    let mut result = String::new();
    for line in m3u8.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        let resolved = resolve(trimmed);
        result.push_str(&proxied(&resolved));
        result.push('\n');
    }
    let re = regex::Regex::new(r#"URI="([^"]+)""#).unwrap();
    re.replace_all(&result, |caps: &regex::Captures| {
        let uri = &caps[1];
        let resolved = resolve(uri);
        format!(r#"URI="{}""#, proxied(&resolved))
    }).to_string()
}