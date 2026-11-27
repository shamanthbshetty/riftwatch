//! Thin client for the existing Axum backend. All endpoints stay in Rust; the
//! native UI only needs the JSON it returns.

use serde::de::DeserializeOwned;

pub async fn get_json<T: DeserializeOwned>(port: u16, path: &str) -> Result<T, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Cannot reach backend: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend returned {}", response.status()));
    }
    response
        .json::<T>()
        .await
        .map_err(|e| format!("Invalid backend response: {e}"))
}

pub fn trending(port: u16) -> impl std::future::Future<Output = Result<Vec<serde_json::Value>, String>> {
    get_json::<Vec<serde_json::Value>>(port, "/api/trending")
}

pub fn popular(port: u16) -> impl std::future::Future<Output = Result<Vec<serde_json::Value>, String>> {
    get_json::<Vec<serde_json::Value>>(port, "/api/popular")
}

pub async fn stream(port: u16, id: &str, episode: u32, mode: &str) -> Result<serde_json::Value, String> {
    let path = format!(
        "/api/stream?id={}&ep={episode}&mode={mode}",
        urlencode(id)
    );
    get_json::<serde_json::Value>(port, &path).await
}

pub async fn episodes(port: u16, id: &str) -> Result<serde_json::Value, String> {
    let path = format!("/api/episodes?id={}", urlencode(id));
    get_json::<serde_json::Value>(port, &path).await
}

pub async fn search(port: u16, query: &str) -> Result<Vec<serde_json::Value>, String> {
    let path = format!("/api/search?q={}", urlencode(query));
    get_json::<Vec<serde_json::Value>>(port, &path).await
}

/// Minimal percent-encoding for query/path arguments.
pub fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
