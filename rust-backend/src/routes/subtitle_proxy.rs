// Subtitle proxy (port of src/app/api/movies/subtitle-proxy/route.ts).
// Owned by the stream migration. Fetches upstream text and converts ASS/SRT
// to WebVTT.

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;
use std::time::Duration;

use crate::routes::generic_proxy::read_capped;
use crate::safe_url::{is_safe_url, origin_of, safe_get, sanitize_header};
use crate::AppState;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// Subtitles are small text files; anything bigger is not one.
const MAX_TEXT_BYTES: usize = 5_000_000;
const TEXT_DEADLINE: Duration = Duration::from_secs(15);
const HEADERS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct Q {
    pub url: Option<String>,
    pub referer: Option<String>,
    pub origin: Option<String>,
}

static RE_ASS_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+):(\d+):(\d+)\.(\d+)").unwrap());
static RE_BRACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{[^}]*\}").unwrap());
static RE_P_STYLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\p[1-9]").unwrap());
static RE_P_ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\p\d").unwrap());
static RE_SRT_CUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})").unwrap()
});
// JS: /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m
static RE_SRT_SNIFF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->").unwrap());
// JS: /^Dialogue:\s*\d+,.../ with captures 1=start 2=end 3=style 4=name
// 5=pre-text field 6=Text. The bare [^,]* separators (MarginL/R, Effect) are
// not capture groups.
static RE_DIALOGUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^Dialogue:\s*\d+,(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),([^,]*),([^,]*),[^,]*,[^,]*,[^,]*,([^,]*),(.*)",
    )
    .unwrap()
});

fn ass_time_to_ms(t: &str) -> u64 {
    let Some(caps) = RE_ASS_TIME.captures(t.trim()) else {
        return 0;
    };
    let parse = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u64>().ok()).unwrap_or(0);
    parse(1) * 3_600_000 + parse(2) * 60_000 + parse(3) * 1_000 + parse(4) * 10
}

fn ms_to_vtt_time(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let millis = ms % 1_000;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, millis)
}

fn strip_ass_tags(text: &str) -> String {
    let mut t = RE_BRACE.replace_all(text, "").to_string();
    if RE_P_STYLE.is_match(&t) {
        return String::new();
    }
    t = RE_P_ANY.replace_all(&t, "").to_string();
    t = t.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ");
    t.trim().to_string()
}

fn srt_to_vtt(srt: &str) -> String {
    let normalized = srt.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut cues: Vec<String> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();
        if line.is_empty() || !line.chars().all(|c| c.is_ascii_digit()) {
            i += 1;
            continue;
        }

        i += 1;
        let time_line = lines.get(i).map(|l| l.trim()).unwrap_or("");
        i += 1;
        let Some(tc) = RE_SRT_CUE.captures(time_line) else {
            continue;
        };

        let start = tc[1].replace(',', ".");
        let end = tc[2].replace(',', ".");
        let mut text_lines: Vec<&str> = Vec::new();
        while i < lines.len() && lines[i].trim() != "" {
            text_lines.push(lines[i]);
            i += 1;
        }
        if !text_lines.is_empty() {
            cues.push(format!("{} --> {}\n{}", start, end, text_lines.join("\n")));
        }
        i += 1;
    }

    format!("WEBVTT\n\n{}", cues.join("\n\n"))
}

fn ass_to_vtt(ass_content: &str) -> String {
    let mut cues: Vec<String> = Vec::new();
    let mut cue_index = 0;

    for line in ass_content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(caps) = RE_DIALOGUE.captures(line) else {
            continue;
        };
        let raw_text = &caps[6];
        if RE_P_STYLE.is_match(raw_text) {
            continue;
        }
        let text = strip_ass_tags(raw_text);
        if text.is_empty() {
            continue;
        }

        let start_ms = ass_time_to_ms(&caps[1]);
        let end_ms = ass_time_to_ms(&caps[2]);
        cue_index += 1;
        cues.push(format!(
            "{}\n{} --> {}\n{}",
            cue_index,
            ms_to_vtt_time(start_ms),
            ms_to_vtt_time(end_ms),
            text
        ));
    }

    format!("WEBVTT\n\n{}", cues.join("\n\n"))
}

pub async fn handler(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    // Missing url is forbidden here too — the TS route merges both checks
    // into one 403.
    let url = match q.url.filter(|u| !u.is_empty()) {
        Some(u) if is_safe_url(&u).await => u,
        _ => return (StatusCode::FORBIDDEN, "forbidden").into_response(),
    };

    let referer = sanitize_header(q.referer.as_deref().filter(|r| !r.is_empty()).unwrap_or(&url));
    let origin = q
        .origin
        .clone()
        .or_else(|| origin_of(&referer))
        .unwrap_or_default();

    let fetch_headers: Vec<(String, String)> = vec![
        ("User-Agent".into(), UA.into()),
        ("Referer".into(), referer),
        ("Origin".into(), origin),
    ];

    let res = match tokio::time::timeout(
        HEADERS_TIMEOUT,
        safe_get(&state.http_safe, &url, &fetch_headers),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("subtitle-proxy error: {}", e),
            )
                .into_response()
        }
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "subtitle-proxy error: upstream headers timed out",
            )
                .into_response()
        }
    };

    if !res.status().is_success() {
        let code = res.status().as_u16();
        let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
        return (status, format!("upstream {}", code)).into_response();
    }

    let body = match read_capped(res, MAX_TEXT_BYTES, TEXT_DEADLINE).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("subtitle-proxy error: {}", e),
            )
                .into_response()
        }
    };
    let body = String::from_utf8_lossy(&body).into_owned();

    let is_ass = url.contains(".ass") || body.contains("[Script Info]");
    let is_srt = url.contains(".srt") || (!is_ass && RE_SRT_SNIFF.is_match(&body));
    let vtt = if is_ass {
        ass_to_vtt(&body)
    } else if is_srt {
        srt_to_vtt(&body)
    } else {
        body
    };

    let mut resp = Response::new(axum::body::Body::from(vtt));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("text/vtt; charset=utf-8"),
    );
    resp.headers_mut().insert(
        "access-control-allow-origin",
        HeaderValue::from_static("*"),
    );
    resp.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=600"),
    );
    resp
}
