use axum::{
    Router,
    routing::get,
    response::{IntoResponse, Json},
    extract::State,
};
use serde_json::json;
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer, services::ServeDir};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod routes;
mod config;
mod safe_url;
mod tmdb;
mod anilist;
mod allanime_client;
mod title_score;
mod movie_providers;
mod scrapers;

#[derive(Clone)]
pub struct AppState {
    pub http: reqwest::Client,
    /// Same client but with redirects disabled — proxies re-validate every hop
    /// through `safe_url::safe_get` instead of following them blindly.
    pub http_safe: reqwest::Client,
}

// Desktop app: a handful of worker threads is plenty and keeps idle CPU/memory low.
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    config::load_env();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client");

    let client_safe = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http safe client");

    let state = AppState { http: client, http_safe: client_safe };

    let app = Router::new()
        .route("/health", get(health))
        // Phase 1: proxy routes
        .route("/api/movies/m3u8-proxy", get(routes::m3u8_proxy::handler))
        .route("/api/movies/mp4-proxy", get(routes::mp4_proxy::handler))
        .route("/api/movies/subtitle-proxy", get(routes::subtitle_proxy::handler))
        .route("/api/proxy", get(routes::generic_proxy::handler))
        .route("/api/episodes", get(routes::episodes::handler))
        // Movie/TV JSON API (was Next.js route handlers)
        .route("/api/movies/details", get(routes::movies_api::details))
        .route("/api/movies/episodes", get(routes::movies_api::episodes))
        .route("/api/movies/popular", get(routes::movies_api::popular))
        .route("/api/movies/recommendations", get(routes::movies_api::recommendations))
        .route("/api/movies/search", get(routes::movies_api::search))
        .route("/api/movies/top-rated", get(routes::movies_api::top_rated))
        .route("/api/movies/trending", get(routes::movies_api::trending))
        .route("/api/movies/tv-episodes", get(routes::movies_api::tv_episodes))
        .route("/api/movies/videos", get(routes::movies_api::videos))
        .route("/api/movies/trailer", get(routes::movies_api::trailer))
        .route("/api/movies/stream", get(routes::movies_api::stream))
        // Anime discovery JSON API (was Next.js route handlers)
        .route("/api/health", get(routes::anime_api::health))
        .route("/api/jikan-anime", get(routes::anime_api::jikan_anime))
        .route("/api/relations", get(routes::anime_api::relations))
        .route("/api/anime/trailer", get(routes::anime_api::trailer))
        .route("/api/anime/recommendations", get(routes::anime_api::recommendations))
        .route("/api/titles", get(routes::anime_api::titles))
        .route("/api/schedule", get(routes::anime_api::schedule))
        .route("/api/search", get(routes::anime_api::search))
        .route("/api/spotlight", get(routes::anime_api::spotlight))
        .route("/api/trending", get(routes::anime_api::trending))
        .route("/api/popular", get(routes::anime_api::popular))
        .route("/api/top-rated", get(routes::anime_api::top_rated))
        .route("/api/random", get(routes::anime_api::random))
        .route("/api/stream", get(routes::stream::handler))
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
