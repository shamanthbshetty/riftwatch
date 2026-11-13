// Megaplay player source extraction (port of src/lib/megaplay.ts). Shared by
// the anikoto and aniwatch scrapers. Owned by the stream migration.
//
// Returns 0 or 1 StreamResult-shaped objects (the MegaExtract fields: playerName,
// streamUrl, subtitles, intro, outro); the caller merges them into its own
// StreamResult with serverName/embedUrl.

use base64::Engine;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use std::time::Duration;

use crate::safe_url::is_safe_url;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MEGA_ENC_KEY: &str = "i?LMTAx0Q6,:}50U";
const MEGA_ENC_IV: &str = "W0;27ToaUpl_P%'c";

static RE_DATA_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"data-id="(\d+)""#).unwrap());
static RE_BASE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"base_url:\s*'([^']+)'").unwrap());
static RE_ABSOLUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());
static RE_M3U8: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.m3u8(\?|$)").unwrap());
static RE_VTT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.vtt(\?|$)").unwrap());
static RE_TRACK_LANG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)track[_-]\d+[_-]([a-z]{2,3})").unwrap());
static RE_SOURCE_MP4: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<source[^>]+src=["']([^"']+)["'][^>]*type=["']video/(?:mp4|webm|ogg)["']"#).unwrap()
});
static RE_VIDEO_MP4: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<video[^>]+src=["']([^"']+\.(?:mp4|webm|ogg)(?:\?[^"']*)?)["']"#).unwrap()
});
static RE_IFRAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<iframe[^>]+src=["']([^"']+)["']"#).unwrap());

pub async fn extract_player_sources(
    client: &reqwest::Client,
    embed_url: &str,
    referer: &str,
) -> Result<Vec<Value>, String> {
    // TS receives the first page HTML from the caller's availability check;
    // the frozen contract only passes (embed_url, referer), so fetch it here.
    let mut page = match fetch_page(client, embed_url, referer, true).await {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let mut page_url = embed_url.to_string();

    // At most one iframe hop: wrappers serve a shell page that iframes the
    // actual player page.
    for _hop in 0..2 {
        if let Some(caps) = RE_DATA_ID.captures(&page) {
            return Ok(match get_sources_result(client, &page, &page_url, &caps[1]).await {
                Some(v) => vec![v],
                None => vec![],
            });
        }

        // Direct-file players: a plain <source>/<video> that is Referer-gated,
        // served through the mp4 proxy which forwards Range requests.
        if let Some(caps) = RE_SOURCE_MP4
            .captures(&page)
            .or_else(|| RE_VIDEO_MP4.captures(&page))
        {
            let raw = &caps[1];
            let file = if RE_ABSOLUTE.is_match(raw) {
                raw.to_string()
            } else {
                match resolve_against(&page_url, raw) {
                    Some(u) => u,
                    None => return Ok(vec![]),
                }
            };
            if is_safe_url(&file).await {
                let origin = match origin_of(&page_url) {
                    Some(o) => o,
                    None => return Ok(vec![]),
                };
                return Ok(vec![json!({
                    "playerName": "Direct",
                    "streamUrl": format!(
                        "/api/movies/mp4-proxy?url={}&referer={}",
                        urlencoding::encode(&file),
                        urlencoding::encode(&format!("{}/", origin))
                    ),
                })]);
            }
        }

        let inner = match RE_IFRAME.captures(&page) {
            Some(c) => c[1].to_string(),
            None => return Ok(vec![]),
        };
        let next = if RE_ABSOLUTE.is_match(&inner) {
            inner
        } else {
            match resolve_against(&page_url, &inner) {
                Some(u) => u,
                None => return Ok(vec![]),
            }
        };
        if !is_safe_url(&next).await {
            return Ok(vec![]);
        }
        // Hops carry the original embed as Referer (TS megaFetchPage).
        let next_html = match fetch_page(client, &next, embed_url, false).await {
            Some(h) => h,
            None => return Ok(vec![]),
        };
        page = next_html;
        page_url = next;
    }
    Ok(vec![])
}

async fn get_sources_result(
    client: &reqwest::Client,
    page: &str,
    page_url: &str,
    data_id: &str,
) -> Option<Value> {
    let origin = origin_of(page_url)?;
    let base = match RE_BASE_URL.captures(page) {
        Some(c) => ensure_trailing_slash(&c[1]),
        None => format!("{}/videojs/", origin),
    };
    let res = client
        .get(format!("{}stream/getSources?id={}", base, data_id))
        .header(reqwest::header::USER_AGENT, AGENT)
        .header(reqwest::header::REFERER, page_url)
        .header("X-Requested-With", "XMLHttpRequest")
        .timeout(Duration::from_millis(8000))
        .send()
        .await
        .ok()?;
    if res.status().as_u16() >= 400 {
        return None;
    }
    let j: Value = res.json().await.ok()?;
    if j.is_null() {
        return None;
    }
    // The player's own loader: file + nothing else comes from the decrypted
    // payload; tracks and the skip windows ride on the top-level response.
    let payload = match j.get("enc").and_then(|e| e.as_str()) {
        Some(enc) => mega_decrypt(enc)?,
        None => j.clone(),
    };
    let file = payload
        .get("file")
        .and_then(|v| v.as_str())
        .or_else(|| {
            payload
                .get("sources")
                .and_then(|s| s.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.get("file"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string();
    if !RE_M3U8.is_match(&file) || !is_safe_url(&file).await {
        return None;
    }
    let mp_origin = format!("{}/", origin);

    // Track files carry a language code in their path (track_1_ara.vtt);
    // upstream labels don't.
    let mut subtitles: Vec<Value> = Vec::new();
    if let Some(tracks) = j.get("tracks").and_then(|t| t.as_array()) {
        for t in tracks {
            let f = t.get("file").and_then(|v| v.as_str()).unwrap_or("");
            if f.is_empty() {
                continue;
            }
            let kind = t.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            if !(kind == "captions" || kind == "subtitles" || RE_VTT.is_match(f)) {
                continue;
            }
            let label = t
                .get("label")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Subtitles");
            let srclang = RE_TRACK_LANG
                .captures(f)
                .map(|c| c[1].to_lowercase())
                .unwrap_or_else(|| "en".to_string());
            subtitles.push(json!({
                "label": label,
                "url": format!(
                    "/api/movies/subtitle-proxy?url={}&referer={}",
                    urlencoding::encode(f),
                    urlencoding::encode(&mp_origin)
                ),
                "srclang": srclang,
            }));
        }
    }

    let mut out = Map::new();
    out.insert("playerName".into(), json!("Megaplay"));
    out.insert(
        "streamUrl".into(),
        json!(format!(
            "/api/movies/m3u8-proxy?url={}&referer={}",
            urlencoding::encode(&file),
            urlencoding::encode(&mp_origin)
        )),
    );
    out.insert("subtitles".into(), json!(subtitles));
    if let Some(v) = clean_window(j.get("intro")) {
        out.insert("intro".into(), v);
    }
    if let Some(v) = clean_window(j.get("outro")) {
        out.insert("outro".into(), v);
    }
    Some(Value::Object(out))
}

fn clean_window(v: Option<&Value>) -> Option<Value> {
    let w = v?;
    let start = w.get("start")?.as_f64()?;
    let end = w.get("end")?.as_f64()?;
    if start.is_finite() && end.is_finite() && end > start {
        Some(json!({ "start": w.get("start")?.clone(), "end": w.get("end")?.clone() }))
    } else {
        None
    }
}

async fn fetch_page(
    client: &reqwest::Client,
    url: &str,
    referer: &str,
    xhr: bool,
) -> Option<String> {
    let mut req = client
        .get(url)
        .header(reqwest::header::USER_AGENT, AGENT)
        .timeout(Duration::from_millis(8000));
    if !referer.is_empty() {
        req = req.header(reqwest::header::REFERER, referer);
    }
    if xhr {
        req = req.header("X-Requested-With", "XMLHttpRequest");
    }
    let res = req.send().await.ok()?;
    if res.status().as_u16() >= 400 {
        return None;
    }
    res.text().await.ok()
}

fn resolve_against(base: &str, reference: &str) -> Option<String> {
    url::Url::parse(base)
        .ok()?
        .join(reference)
        .ok()
        .map(|u| u.to_string())
}

fn origin_of(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .map(|u| u.origin().ascii_serialization())
}

fn ensure_trailing_slash(s: &str) -> String {
    if s.ends_with('/') {
        s.to_string()
    } else {
        format!("{}/", s)
    }
}

// --- AES-256-CBC (megaplay getSources `enc` payload) -----------------------
// No crypto crate is available in Cargo.toml, so the FIPS-197 inverse cipher
// is implemented here. Tables are derived (S-box = GF inverse + affine) to
// avoid transcribing the 256-entry constants by hand.

fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut r = 0u8;
    while b != 0 {
        if b & 1 != 0 {
            r ^= a;
        }
        a = if a & 0x80 != 0 { (a << 1) ^ 0x1b } else { a << 1 };
        b >>= 1;
    }
    r
}

fn build_tables() -> ([u8; 256], [u8; 256]) {
    let mut inverses = [0u8; 256];
    for a in 1..256u16 {
        for b in 1..256u16 {
            if gf_mul(a as u8, b as u8) == 1 {
                inverses[a as usize] = b as u8;
                break;
            }
        }
    }
    let mut sbox = [0u8; 256];
    let mut inv_sbox = [0u8; 256];
    for i in 0..256 {
        let s = inverses[i];
        let aff = s ^ s.rotate_left(1) ^ s.rotate_left(2) ^ s.rotate_left(3) ^ s.rotate_left(4) ^ 0x63;
        sbox[i] = aff;
        inv_sbox[aff as usize] = i as u8;
    }
    (sbox, inv_sbox)
}

static TABLES: LazyLock<([u8; 256], [u8; 256])> = LazyLock::new(build_tables);

fn expand_key(key: &[u8; 32]) -> [u8; 240] {
    let sbox = &TABLES.0;
    let mut w = [0u8; 240];
    w[..32].copy_from_slice(key);
    let mut rcon = 1u8;
    let mut bytes = 32usize;
    while bytes < 240 {
        let mut t = [w[bytes - 4], w[bytes - 3], w[bytes - 2], w[bytes - 1]];
        let word_idx = bytes / 4;
        if word_idx % 8 == 0 {
            t = [sbox[t[1] as usize], sbox[t[2] as usize], sbox[t[3] as usize], sbox[t[0] as usize]];
            t[0] ^= rcon;
            rcon = gf_mul(rcon, 2);
        } else if word_idx % 8 == 4 {
            t = [
                sbox[t[0] as usize],
                sbox[t[1] as usize],
                sbox[t[2] as usize],
                sbox[t[3] as usize],
            ];
        }
        for i in 0..4 {
            w[bytes + i] = w[bytes - 32 + i] ^ t[i];
        }
        bytes += 4;
    }
    w
}

fn add_round_key(state: &mut [u8; 16], key: &[u8]) {
    for i in 0..16 {
        state[i] ^= key[i];
    }
}

fn inv_shift_rows(s: &mut [u8; 16]) {
    let t = *s;
    s[1] = t[13];
    s[5] = t[1];
    s[9] = t[5];
    s[13] = t[9];
    s[2] = t[10];
    s[6] = t[14];
    s[10] = t[2];
    s[14] = t[6];
    s[3] = t[7];
    s[7] = t[11];
    s[11] = t[15];
    s[15] = t[3];
}

fn inv_mix_columns(s: &mut [u8; 16]) {
    for col in 0..4 {
        let i = col * 4;
        let a = s[i];
        let b = s[i + 1];
        let c = s[i + 2];
        let d = s[i + 3];
        s[i] = gf_mul(a, 0x0e) ^ gf_mul(b, 0x0b) ^ gf_mul(c, 0x0d) ^ gf_mul(d, 0x09);
        s[i + 1] = gf_mul(a, 0x09) ^ gf_mul(b, 0x0e) ^ gf_mul(c, 0x0b) ^ gf_mul(d, 0x0d);
        s[i + 2] = gf_mul(a, 0x0d) ^ gf_mul(b, 0x09) ^ gf_mul(c, 0x0e) ^ gf_mul(d, 0x0b);
        s[i + 3] = gf_mul(a, 0x0b) ^ gf_mul(b, 0x0d) ^ gf_mul(c, 0x09) ^ gf_mul(d, 0x0e);
    }
}

fn decrypt_block(rk: &[u8; 240], block: &mut [u8; 16]) {
    let inv_sbox = &TABLES.1;
    add_round_key(block, &rk[224..240]);
    for round in (1..14).rev() {
        inv_shift_rows(block);
        for b in block.iter_mut() {
            *b = inv_sbox[*b as usize];
        }
        add_round_key(block, &rk[round * 16..round * 16 + 16]);
        inv_mix_columns(block);
    }
    inv_shift_rows(block);
    for b in block.iter_mut() {
        *b = inv_sbox[*b as usize];
    }
    add_round_key(block, &rk[0..16]);
}

fn aes256_cbc_decrypt(key: &[u8; 32], iv: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let rk = expand_key(key);
    let mut prev = *iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        block.copy_from_slice(chunk);
        let cipher = block;
        decrypt_block(&rk, &mut block);
        for i in 0..16 {
            block[i] ^= prev[i];
        }
        prev = cipher;
        out.extend_from_slice(&block);
    }
    // PKCS#7 unpad (node:crypto decipher removes it by default).
    let pad = *out.last()? as usize;
    if pad == 0 || pad > 16 || out.len() < pad {
        return None;
    }
    if out[out.len() - pad..].iter().any(|&b| b != pad as u8) {
        return None;
    }
    out.truncate(out.len() - pad);
    Some(out)
}

fn pad_str(s: &str, n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    let bytes = s.as_bytes();
    let l = bytes.len().min(n);
    b[..l].copy_from_slice(&bytes[..l]);
    b
}

fn mega_b64_url_decode(e: &str) -> Option<Vec<u8>> {
    let mut t = e.replace('-', "+").replace('_', "/");
    let a = t.len() % 4;
    if a != 0 {
        t.push_str(&"===="[..4 - a]);
    }
    base64::engine::general_purpose::STANDARD.decode(t).ok()
}

fn mega_decrypt(enc: &str) -> Option<Value> {
    let data = mega_b64_url_decode(enc)?;
    let key = pad_str(MEGA_ENC_KEY, 32);
    let iv = pad_str(MEGA_ENC_IV, 16);
    let plain = aes256_cbc_decrypt(
        key.as_slice().try_into().ok()?,
        iv.as_slice().try_into().ok()?,
        &data,
    )?;
    serde_json::from_slice(&plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sbox_spot_values() {
        assert_eq!(TABLES.0[0x00], 0x63);
        assert_eq!(TABLES.0[0x53], 0xED);
        assert_eq!(TABLES.0[0xFF], 0x16);
        assert_eq!(TABLES.1[0x63], 0x00);
        assert_eq!(TABLES.1[0xED], 0x53);
    }

    #[test]
    fn aes256_decrypt_fips197_c3() {
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let cipher = [
            0x8e, 0xa2, 0xb7, 0xca, 0x51, 0x67, 0x45, 0xbf, 0xea, 0xfc, 0x49, 0x90, 0x4b, 0x49,
            0x60, 0x89,
        ];
        let rk = expand_key(&key);
        let mut block = cipher;
        decrypt_block(&rk, &mut block);
        let expected = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];
        assert_eq!(block, expected);
    }

    #[test]
    fn cbc_roundtrip_with_bad_padding_rejected() {
        // A single block whose plaintext ends in valid PKCS#7 padding.
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let iv = [0u8; 16];
        // Encrypt nothing is not available; just verify the padding gate rejects
        // the FIPS plaintext (last byte 0xff is not a valid pad length).
        let cipher = [
            0x8e, 0xa2, 0xb7, 0xca, 0x51, 0x67, 0x45, 0xbf, 0xea, 0xfc, 0x49, 0x90, 0x4b, 0x49,
            0x60, 0x89,
        ];
        assert!(aes256_cbc_decrypt(&key, &iv, &cipher).is_none());
    }
}
