// MP4 media proxy (port of src/app/api/movies/mp4-proxy/route.ts).
// Owned by the stream migration. Pass-through with Range support — video can
// be multi-GB, so the body streams unbounded after a headers-only timeout.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::time::Duration;

use crate::safe_url::{is_safe_url, origin_of, safe_get, sanitize_header};
use crate::AppState;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const HEADERS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct Q {
    pub url: Option<String>,
    pub referer: Option<String>,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(q): Query<Q>,
    headers_in: HeaderMap,
) -> Response {
    let url = match q.url.filter(|u| !u.is_empty()) {
        Some(u) => u,
        None => return (StatusCode::BAD_REQUEST, "url required").into_response(),
    };
    if !is_safe_url(&url).await {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let referer = sanitize_header(q.referer.as_deref().unwrap_or(""));
    let origin = origin_of(&referer).unwrap_or_default();
    let range = headers_in
        .get("range")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(sanitize_header);

    let mut fetch_headers: Vec<(String, String)> = vec![("User-Agent".into(), UA.into())];
    if !referer.is_empty() {
        fetch_headers.push(("Referer".into(), referer));
    }
    if !origin.is_empty() {
        fetch_headers.push(("Origin".into(), origin));
    }
    if let Some(range) = range {
        fetch_headers.push(("Range".into(), range));
    }

    // Headers-only timeout: cleared once the response headers arrive, so
    // multi-GB video downloads are never cut mid-transfer (client has no
    // total timeout).
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
                format!("mp4-proxy error: {}", e),
            )
                .into_response()
        }
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "mp4-proxy error: upstream headers timed out",
            )
                .into_response()
        }
    };

    if !res.status().is_success() {
        let code = res.status().as_u16();
        let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
        return (status, format!("upstream {}", code)).into_response();
    }

    // Snapshot headers before the body is moved into the stream.
    let upstream_status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::OK);
    let content_type = res.headers().get(reqwest::header::CONTENT_TYPE).cloned();
    let content_length = res.headers().get(reqwest::header::CONTENT_LENGTH).cloned();
    let content_range = res.headers().get(reqwest::header::CONTENT_RANGE).cloned();
    let accept_ranges = res.headers().get(reqwest::header::ACCEPT_RANGES).cloned();

    let stream = res.bytes_stream();
    let mut resp = Response::new(Body::from_stream(stream));
    *resp.status_mut() = upstream_status;

    let content_type = content_type
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| HeaderValue::from_static("video/mp4"));
    resp.headers_mut()
        .insert(reqwest::header::CONTENT_TYPE, content_type);
    resp.headers_mut().insert(
        "access-control-allow-origin",
        HeaderValue::from_static("*"),
    );
    resp.headers_mut().insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Range"),
    );
    resp.headers_mut().insert(
        "access-control-expose-headers",
        HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
    );
    resp.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=86400"),
    );
    if let Some(v) = content_length {
        resp.headers_mut()
            .insert(reqwest::header::CONTENT_LENGTH, v);
    }
    if let Some(v) = content_range {
        resp.headers_mut().insert(reqwest::header::CONTENT_RANGE, v);
    }
    match accept_ranges {
        Some(v) => {
            resp.headers_mut()
                .insert(reqwest::header::ACCEPT_RANGES, v);
        }
        None => {
            resp.headers_mut()
                .insert(reqwest::header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        }
    }
    resp
}
