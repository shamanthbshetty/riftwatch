// Env loading + upstream domain-rotation helpers (port of src/lib/upstream.ts).
// Every provider scrapes an unofficial mirror whose domain dies regularly, so
// base URLs are env-overridable lists with fallback instead of hardcoding.

/// Load `.env.local` then `.env` into the process env (Next.js reads
/// `.env.local`; dotenvy only knows `.env`).
pub fn load_env() {
    for f in [".env.local", ".env"] {
        dotenvy::from_path(f).ok();
    }
}

/// Read a single string env var with a default.
pub fn env_str(name: &str, def: &str) -> String {
    std::env::var(name)
        .map(|v| v.trim().to_string())
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| def.to_string())
}

/// Read a comma-separated URL/host list env var, falling back to defaults.
pub fn env_list(name: &str, defaults: &[&str]) -> Vec<String> {
    let raw = std::env::var(name).unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return defaults.iter().map(|s| s.to_string()).collect();
    }
    let out: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| normalize_base(&s))
        .collect();
    if out.is_empty() {
        defaults.iter().map(|s| s.to_string()).collect()
    } else {
        out
    }
}

/// Strip trailing slashes so `{base}/path` never becomes `//path`.
pub fn normalize_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Parse `https://host|Label, https://other` entries into (host, label) pairs.
pub fn parse_mirror_list(entries: &[String], default_labels: &[(&str, &str)]) -> Vec<(String, String)> {
    entries
        .iter()
        .map(|entry| {
            let mut parts = entry.splitn(2, '|');
            let host = normalize_base(parts.next().unwrap_or("").trim());
            let label = parts.next().map(str::trim).unwrap_or("");
            if !label.is_empty() {
                return (host, label.to_string());
            }
            if let Some((_, known)) = default_labels.iter().find(|(h, _)| *h == host) {
                return (host, known.to_string());
            }
            let label = url::Url::parse(&host)
                .ok()
                .map(|u| format!("Anikoto {}", u.host_str().unwrap_or("")))
                .unwrap_or_else(|| host.clone());
            (host, label)
        })
        .collect()
}
