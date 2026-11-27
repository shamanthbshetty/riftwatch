//! Local persistence. The web app used localStorage; the native app keeps a
//! single JSON file in the per-user config directory instead.

use crate::models::{HistoryEntry, Settings, WatchEntry};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Store {
    #[serde(default)]
    pub watchlist: Vec<WatchEntry>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub settings: Settings,
}

impl Store {
    fn path() -> PathBuf {
        let dir = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("com.riftwatch.app")
            .join("native");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("data.json")
    }

    pub fn load() -> Self {
        let Ok(bytes) = std::fs::read(Self::path()) else {
            return Self::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    pub fn save(&self) {
        let Ok(bytes) = serde_json::to_vec_pretty(self) else {
            return;
        };
        let _ = std::fs::write(Self::path(), bytes);
    }
}
