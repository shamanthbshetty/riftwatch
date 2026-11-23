// MP4 media proxy (port of src/app/api/movies/mp4-proxy/route.ts).
// Owned by the stream migration. Pass-through with Range support — video can
// be multi-GB.
//
// Two rules keep long videos from stalling:
//   1. Never apply a total request timeout to the body. Only the response
//      headers are timed, and an idle-read timeout aborts a dead connection.
//   2. If the upstream connection dies or goes silent mid-body, resume with a
//      fresh `Range` request from the last byte sent instead of dropping the
//      client response. Players otherwise wait forever on the truncated body.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::Stream;
use serde::Deserialize;
use std::io;
use std::time::Duration;

use crate::safe_url::{is_safe_url, origin_of, safe_get, sanitize_header};
use crate::AppState;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const HEADERS_TIMEOUT: Duration = Duration::from_secs(15);
/// Max time between body chunks before the upstream is considered dead.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(25);
/// How many times one client response may reconnect upstream.
const MAX_RESUMES: u32 = 6;

#[derive(Deserialize)]
pub struct Q {
    pub url: Option<String>,
    pub referer: Option<String>,
}

/// `Content-Range: bytes 123-456/789` -> (123, 456)
fn parse_content_range(v: &HeaderValue) -> Option<(u64, u64)> {
    let s = v.to_str().ok()?.trim();
    let rest = s.strip_prefix("bytes")?.trim();
    let (range, _total) = rest.split_once('/')?;
    let (a, b) = range.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

struct ResumeState {
    client: reqwest::Client,
    url: String,
    /// Headers without a Range header; each resume adds its own.
    base_headers: Vec<(String, String)>,
    start: u64,
    end: u64,
    sent: u64,
    retries: u32,
    res: Option<reqwest::Response>,
}

/// Streams `total` bytes starting at `start`, transparently reconnecting with
/// a Range request when the upstream body errors, ends early, or goes idle.
fn resumable_stream(
    state: ResumeState,
    start: u64,
    end: u64,
    first: reqwest::Response,
) -> impl Stream<Item = Result<Bytes, io::Error>> {
    let total = end.saturating_sub(start) + 1;
    let init = ResumeState { res: Some(first), ..state };

    futures::stream::unfold(init, move |mut st| async move {
        loop {
            if st.sent >= total {
                return None;
            }

            if st.res.is_none() {
                if st.retries >= MAX_RESUMES {
                    return Some((
                        Err(io::Error::new(
                            io::ErrorKind::Other,
                            "mp4-proxy: upstream stalled",
                        )),
                        st,
                    ));
                }
                st.retries += 1;
                let from = st.start + st.sent;
                let mut headers = st.base_headers.clone();
                headers.push(("Range".into(), format!("bytes={}-{}", from, st.end)));
                match safe_get(&st.client, &st.url, &headers).await {
                    Ok(r) if r.status() == StatusCode::PARTIAL_CONTENT => st.res = Some(r),
                    // A resume that is not a 206 cannot be spliced correctly.
                    Ok(_) => {
                        return Some((
                            Err(io::Error::new(
                                io::ErrorKind::Other,
                                "mp4-proxy: upstream refused resume",
                            )),
                            st,
                        ))
                    }
                    Err(_) => continue,
                }
            }

            let chunk = {
                let res = st.res.as_mut().expect("response present");
                tokio::time::timeout(READ_IDLE_TIMEOUT, res.chunk()).await
            };

            match chunk {
                Ok(Ok(Some(chunk))) => {
                    let remaining = (total - st.sent) as usize;
                    let out = if chunk.len() > remaining {
                        chunk.slice(..remaining)
                    } else {
                        chunk
                    };
                    st.sent += out.len() as u64;
                    return Some((Ok(out), st));
                }
                // Premature EOF, transport error, or idle timeout: reconnect.
                Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                    st.res = None;
                    continue;
                }
            }
        }
    })
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

    let mut base_headers: Vec<(String, String)> = vec![("User-Agent".into(), UA.into())];
    if !referer.is_empty() {
        base_headers.push(("Referer".into(), referer));
    }
    if !origin.is_empty() {
        base_headers.push(("Origin".into(), origin));
    }
    let mut fetch_headers = base_headers.clone();
    if let Some(range) = range {
        fetch_headers.push(("Range".into(), range));
    }

    // Headers-only timeout: cleared once the response headers arrive, so
    // multi-GB video downloads are never cut mid-transfer.
    let res = match tokio::time::timeout(
        HEADERS_TIMEOUT,
        safe_get(&state.http_stream, &url, &fetch_headers),
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

    // Byte span this response covers. A 206 gives it exactly; a 200 covers the
    // whole file. Without a usable span there is nothing to resume from.
    let span = if upstream_status == StatusCode::PARTIAL_CONTENT {
        content_range.as_ref().and_then(parse_content_range)
    } else {
        content_length
            .as_ref()
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|len| (0, len.saturating_sub(1)))
    };

    let stream: axum::body::Body = match span {
        Some((start, end)) if end >= start => {
            let init = ResumeState {
                client: state.http_stream.clone(),
                url: url.clone(),
                base_headers,
                start,
                end,
                sent: 0,
                retries: 0,
                res: None,
            };
            Body::from_stream(resumable_stream(init, start, end, res))
        }
        _ => Body::from_stream(res.bytes_stream()),
    };

    let mut resp = Response::new(stream);
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
