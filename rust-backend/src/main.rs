use axum::{
    Router,
    routing::{get, post},
    http::StatusCode,
    response::{IntoResponse, Response, Json},
    extract::State,
};
use serde_json::json;
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer, services::ServeDir};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod routes;

#[derive(Clone)]
pub struct AppState {
    pub http: reqwest::Client,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client");

    let state = AppState { http: client };

    let app = Router::new()
        .route("/health", get(health))
        // Phase 1: proxy routes
        .route("/api/movies/m3u8-proxy", get(routes::m3u8_proxy::handler))
        .route("/api/movies/mp4-proxy", get(routes::mp4_proxy::handler))
        .route("/api/movies/subtitle-proxy", get(routes::subtitle_proxy::handler))
        .route("/api/proxy", get(routes::generic_proxy::handler))
        .route("/api/episodes", get(routes::episodes::handler))
        .nest_service("/static", ServeDir::new("out"))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3001);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("riftwatch-backend listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health(State(_state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "ok": true }))
}
