// Generic embed/resource proxy (port of src/app/api/proxy/route.ts).
// Owned by the stream migration. Also exports `read_capped` for the subtitle
// proxy (same body-cap helper as safe-url.ts).

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, Instant};

use crate::safe_url::{is_safe_url, origin_of, safe_get, sanitize_header};
use crate::AppState;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Embed pages are HTML/JS documents; anything past this is not one.
const MAX_BODY_BYTES: usize = 10_000_000;
const BODY_DEADLINE: Duration = Duration::from_secs(20);
const HEADERS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct Q {
    pub url: Option<String>,
    pub src: Option<String>,
    pub referer: Option<String>,
}

/// Read a binary body with a hard byte cap and wall-clock deadline
/// (port of readCapped in src/lib/safe-url.ts).
pub(crate) async fn read_capped(
    res: reqwest::Response,
    max_bytes: usize,
    deadline: Duration,
) -> Result<bytes::Bytes, String> {
    if let Some(declared) = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if declared > max_bytes as u64 {
            return Err(format!("upstream body too large ({declared} bytes)"));
        }
    }

    let mut stream = res.bytes_stream();
    let mut chunks: Vec<u8> = Vec::new();
    let end_at = Instant::now() + deadline;
    loop {
        let remain = end_at.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return Err("upstream body timed out".into());
        }
        match tokio::time::timeout(remain, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                if chunks.len() + chunk.len() > max_bytes {
                    return Err(format!("upstream body too large (>{max_bytes} bytes)"));
                }
                chunks.extend_from_slice(&chunk);
            }
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(None) => break,
            Err(_) => return Err("upstream body timed out".into()),
        }
    }
    Ok(bytes::Bytes::from(chunks))
}

pub async fn handler(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    // `url ?? src`: a present-but-empty `url` wins and fails below, exactly as
    // JS `??` does.
    let url = q.url.clone().or(q.src);
    let referer = sanitize_header(q.referer.as_deref().unwrap_or(""));
    let url = match url {
        Some(u) if !u.is_empty() => u,
        _ => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "url required" }))).into_response();
        }
    };
    if !is_safe_url(&url).await {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response();
    }

    let mut fetch_headers: Vec<(String, String)> = vec![("User-Agent".into(), AGENT.into())];
    if !referer.is_empty() {
        fetch_headers.push(("Referer".into(), referer.clone()));
    }
    if let Some(origin) = origin_of(&referer) {
        fetch_headers.push(("Origin".into(), origin));
    }

    let res = match tokio::time::timeout(
        HEADERS_TIMEOUT,
        safe_get(&state.http_safe, &url, &fetch_headers),
    )
    .await
    {
        Ok(Ok(r)) => r,
        // Fixed message: upstream error strings can leak internal DNS/host details.
        Ok(Err(e)) => {
            tracing::error!("[api/proxy] {}", e);
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream fetch failed" })))
                .into_response();
        }
        Err(_) => {
            tracing::error!("[api/proxy] upstream headers timed out");
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream fetch failed" })))
                .into_response();
        }
    };

    if !res.status().is_success() {
        let code = res.status().as_u16();
        tracing::error!("[api/proxy] upstream {}", code);
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("upstream {}", code) })),
        )
            .into_response();
    }

    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .to_string();

    // Never serve upstream HTML from our origin: an attacker-controlled page
    // would execute with access to this app's localStorage (XSS-by-proxy).
    // The only caller proxies video/audio manifests; HTML means the upstream
    // handed back an embed page, which must fail over instead of rendering.
    if content_type.contains("text/html") {
        drop(res); // cancel the body
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "upstream returned html" })),
        )
            .into_response();
    }

    let body = match read_capped(res, MAX_BODY_BYTES, BODY_DEADLINE).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("[api/proxy] {}", e);
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "upstream fetch failed" })))
                .into_response();
        }
    };

    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = StatusCode::OK;
    if let Ok(v) = HeaderValue::from_str(&content_type) {
        resp.headers_mut().insert(reqwest::header::CONTENT_TYPE, v);
    }
    resp.headers_mut()
        .insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    resp
}
