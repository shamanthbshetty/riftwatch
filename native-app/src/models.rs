//! Shared data types for the native UI. These mirror the backend's JSON
//! shapes with forgiving defaults so a missing field never crashes a view.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MediaItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub english_name: String,
    #[serde(default)]
    pub thumbnail: String,
    #[serde(default)]
    pub score: String,
}

impl MediaItem {
    pub fn from_json(value: &serde_json::Value) -> Self {
        let get = |key: &str| -> String {
            value
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        Self {
            id: get("_id"),
            name: get("name"),
            english_name: get("englishName"),
            thumbnail: get("thumbnail"),
            score: value
                .get("score")
                .and_then(|v| v.as_f64())
                .map(|v| format!("{v:.1}"))
                .unwrap_or_default(),
        }
    }

    pub fn title(&self) -> &str {
        if self.english_name.is_empty() {
            &self.name
        } else {
            &self.english_name
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct WatchEntry {
    pub item: MediaItem,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct HistoryEntry {
    pub item: MediaItem,
    pub episode: u32,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default = "default_true")]
    pub autoplay: bool,
    #[serde(default = "default_true")]
    pub auto_skip: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            autoplay: true,
            auto_skip: true,
        }
    }
}
