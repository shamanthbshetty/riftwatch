use axum::{extract::{Query, State}, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use crate::AppState;

#[derive(Deserialize)]
pub struct Q { pub url: Option<String> }

pub async fn handler(State(state): State<AppState>, Query(q): Query<Q>) -> impl IntoResponse {
    let url = match q.url { Some(u) if !u.is_empty() => u, _ => return (StatusCode::BAD_REQUEST, "url required").into_response() };
    // pass-through with Range support
    let mut req = state.http.get(&url);
    // Range header forwarded by caller via query? For simplicity, fetch full.
    match req.send().await {
        Ok(res) => {
            let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
            let bytes = res.bytes().await.unwrap_or_default();
            (StatusCode::OK, [( "content-type", ct)], bytes).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}
