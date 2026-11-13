// SSRF-hardened URL validation for the media proxies (port of src/lib/safe-url.ts).
//
// Threat model: `url`/`src` params are attacker-controllable on public
// deployments. Block private/loopback/link-local targets at three layers:
//   1. literal host checks (incl. IPv6 forms, trailing dots),
//   2. DNS resolution of hostnames with a check on every resolved address,
//   3. re-validation of every redirect hop in `safe_get`.
// Residual risk: DNS rebinding between lookup and connect (TOCTOU) — closing
// it requires pinning the IP at connect time, which breaks TLS/SNI for CDNs.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DNS_CACHE_TTL: Duration = Duration::from_secs(60);
const DNS_CACHE_MAX: usize = 500;
const MAX_REDIRECTS: usize = 10;

fn is_blocked_ipv4(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    if a == 0 || a == 10 || a == 127 {
        return true; // 0/8, 10/8, 127/8
    }
    if a == 169 && b == 254 {
        return true; // link-local incl. cloud metadata
    }
    if a == 172 && (16..=31).contains(&b) {
        return true; // 172.16/12
    }
    if a == 192 && b == 168 {
        return true; // 192.168/16
    }
    if a == 100 && (64..=127).contains(&b) {
        return true; // CGNAT 100.64/10
    }
    if a == 198 && (b == 18 || b == 19) {
        return true; // benchmarking 198.18/15
    }
    if a >= 224 {
        return true; // multicast + reserved + broadcast
    }
    false
}

fn is_blocked_ipv6(raw: &str) -> bool {
    let h = raw
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if h == "::1" || h == "::" || h == "::0" {
        return true;
    }
    if let Ok(ip) = h.parse::<Ipv6Addr>() {
        let seg = ip.segments();
        // IPv4-mapped ::ffff:a.b.c.d / ::a.b.c.d with dotted tail already
        // parsed as Ipv6; check the embedded v4.
        if seg[..5] == [0, 0, 0, 0, 0] && (seg[5] == 0xffff || seg[5] == 0) {
            let v4 = Ipv4Addr::new(
                (seg[6] >> 8) as u8,
                (seg[6] & 0xff) as u8,
                (seg[7] >> 8) as u8,
                (seg[7] & 0xff) as u8,
            );
            return is_blocked_ipv4(&v4);
        }
        let first = seg[0];
        if (first & 0xffc0) == 0xfe80 {
            return true; // link-local fe80::/10
        }
        if (first & 0xffc0) == 0xfec0 {
            return true; // deprecated site-local
        }
        if (first & 0xff00) == 0xfc00 {
            return true; // ULA fc00::/7
        }
        if (first & 0xff00) == 0xff00 {
            return true; // multicast ff00::/8
        }
        return false;
    }
    // Non-standard literal (hex tails etc.) — treat as unsafe.
    true
}

fn dns_cache_get(host: &str) -> Option<bool> {
    let cache = DNS_CACHE.lock().unwrap();
    cache.get(host).and_then(|(safe, ts)| {
        if ts.elapsed() < DNS_CACHE_TTL {
            Some(*safe)
        } else {
            None
        }
    })
}

fn dns_cache_put(host: &str, safe: bool) {
    let mut cache = DNS_CACHE.lock().unwrap();
    if cache.len() >= DNS_CACHE_MAX {
        cache.clear();
    }
    cache.insert(host.to_string(), (safe, Instant::now()));
}

static DNS_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (bool, Instant)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

async fn resolves_public(hostname: &str) -> bool {
    if let Some(cached) = dns_cache_get(hostname) {
        return cached;
    }
    let host = hostname.to_string();
    let safe = tokio::task::spawn_blocking(move || {
        match (host.as_str(), 443u16).to_socket_addrs() {
            Ok(addrs) => {
                let addrs: Vec<_> = addrs.collect();
                addrs.len() > 0
                    && addrs.iter().all(|a| match a.ip() {
                        std::net::IpAddr::V4(v4) => !is_blocked_ipv4(&v4),
                        std::net::IpAddr::V6(v6) => !is_blocked_ipv6(&v6.to_string()),
                    })
            }
            // Unresolvable — fetch would fail anyway; don't open the door.
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false);
    dns_cache_put(hostname, safe);
    safe
}

pub async fn is_safe_url(raw: &str) -> bool {
    let u = match url::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if u.scheme() != "http" && u.scheme() != "https" {
        return false;
    }
    let host = match u.host_str() {
        Some(h) => h,
        None => return false,
    };
    // url crate already canonicalizes decimal/octal/hex IPv4 and lowercases
    // IPv6 the way WHATWG does.
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_lowercase();

    if let Ok(v4) = bare.parse::<Ipv4Addr>() {
        return !is_blocked_ipv4(&v4);
    }
    if bare.contains(':') {
        return !is_blocked_ipv6(&bare);
    }
    if bare == "localhost" || bare.ends_with(".localhost") || bare.ends_with(".local") {
        return false;
    }
    // Single-label names are internal short names; real CDNs contain a dot.
    if !bare.contains('.') {
        return false;
    }
    resolves_public(&bare).await
}

pub fn origin_of(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    url::Url::parse(raw).ok().map(|u| u.origin().ascii_serialization())
}

/// CR/LF in a header value would make the request fail — clean it instead.
pub fn sanitize_header(value: &str) -> String {
    value
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// GET with per-hop SSRF re-validation (client must have redirects disabled).
pub async fn safe_get(
    client: &reqwest::Client,
    raw_url: &str,
    headers: &[(String, String)],
) -> Result<reqwest::Response, String> {
    let mut current = raw_url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        if !is_safe_url(&current).await {
            let host = url::Url::parse(&current)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| "?".into());
            return Err(format!("blocked upstream url ({host})"));
        }
        let mut req = client.get(&current);
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let location = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            match location {
                Some(loc) => {
                    drop(res);
                    current = url::Url::parse(&current)
                        .and_then(|base| base.join(&loc))
                        .map(|u| u.to_string())
                        .map_err(|_| "malformed redirect location".to_string())?;
                    continue;
                }
                None => return Ok(res),
            }
        }
        return Ok(res);
    }
    Err("too many redirects".into())
}
