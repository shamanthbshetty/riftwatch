import axios from "axios";
import crypto from "node:crypto";
import { isSafeUrl } from "./safe-url";
import type { StreamResult, SkipWindow } from "./anikoto";

// Fields an embed can be upgraded with: a direct media URL (HLS or MP4),
// subtitle tracks, the player's own intro/outro windows, and the honest player
// name for labeling (upstream server labels are unreliable). On any failure the
// caller keeps the plain embed as fallback.
export type MegaExtract = Pick<StreamResult, "streamUrl" | "subtitles" | "intro" | "outro" | "playerName">;

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// --- Megaplay getSources extraction ---------------------------------------
// Megaplay player pages (the inner player of Aniwatch and Anikoto embeds)
// expose a getSources endpoint carrying the direct HLS URL (AES-CBC encrypted),
// subtitle tracks, and their own intro/outro windows. Extracting them upgrades
// the embed to a real VideoPlayer stream — the piece that makes Auto Skip,
// auto-next, resume and PiP actually work.

const MEGA_ENC_KEY = "i?LMTAx0Q6,:}50U";
const MEGA_ENC_IV = "W0;27ToaUpl_P%'c";

// The player pads the key/iv strings with zero bytes to 32/16 bytes.
function megaPad(s: string, n: number): Buffer {
  const b = Buffer.alloc(n);
  Buffer.from(String(s), "utf8").copy(b, 0, 0, Math.min(Buffer.byteLength(String(s)), n));
  return b;
}

function megaB64UrlDecode(e: string): Buffer {
  let t = String(e).replace(/-/g, "+").replace(/_/g, "/");
  const a = t.length % 4;
  if (a) t += "====".slice(a);
  return Buffer.from(t, "base64");
}

interface MegaplayPayload {
  file?: string;
  sources?: { file?: string }[];
  tracks?: { file?: string; label?: string; kind?: string }[];
  intro?: SkipWindow;
  outro?: SkipWindow;
  enc?: string;
}

function megaDecrypt(enc: string): MegaplayPayload | null {
  try {
    const d = crypto.createDecipheriv("aes-256-cbc", megaPad(MEGA_ENC_KEY, 32), megaPad(MEGA_ENC_IV, 16));
    return JSON.parse(Buffer.concat([d.update(megaB64UrlDecode(enc)), d.final()]).toString("utf8")) as MegaplayPayload;
  } catch {
    return null;
  }
}

async function megaFetchPage(url: string, referer: string): Promise<string | null> {
  try {
    const r = await axios.get(url, { timeout: 8000, responseType: "text", validateStatus: () => true, headers: { "User-Agent": AGENT, Referer: referer } });
    return r.status < 400 ? String(r.data ?? "") : null;
  } catch {
    return null;
  }
}

export async function extractPlayerSources(embedUrl: string, firstPage: string): Promise<MegaExtract | null> {
  let page = firstPage;
  let pageUrl = embedUrl;
  // At most one iframe hop: wrappers like 1anime.site serve a shell page that
  // iframes the actual player page.
  for (let hop = 0; hop < 2; hop++) {
    const dataId = page.match(/data-id="(\d+)"/)?.[1];
    if (dataId) {
      try {
        const base = (page.match(/base_url:\s*'([^']+)'/)?.[1] ?? `${new URL(pageUrl).origin}/videojs/`).replace(/\/?$/, "/");
        const gs = await axios.get(`${base}stream/getSources?id=${dataId}`, {
          timeout: 8000,
          responseType: "json",
          validateStatus: () => true,
          headers: { "User-Agent": AGENT, Referer: pageUrl, "X-Requested-With": "XMLHttpRequest" },
        });
        const j = (gs.status < 400 ? gs.data : null) as MegaplayPayload | null;
        if (!j) return null;
        // The player's own loader: file + nothing else comes from the decrypted
        // payload; tracks and the skip windows ride on the top-level response.
        const payload = j.enc ? megaDecrypt(j.enc) : j;
        const file = payload?.file || payload?.sources?.[0]?.file || "";
        if (!/\.m3u8(\?|$)/i.test(file) || !(await isSafeUrl(file))) return null;
        const mpOrigin = `${new URL(pageUrl).origin}/`;
        // Track files carry a language code in their path (track_1_ara.vtt);
        // upstream labels don't. The old hardcoded srclang:"en" marked Arabic,
        // French, German tracks as English.
        const trackLang = (file: string) =>
          file.match(/track[_-]\d+[_-]([a-z]{2,3})/i)?.[1]?.toLowerCase() ?? "en";
        const subtitles = (Array.isArray(j.tracks) ? j.tracks : [])
          .filter((t) => {
            const f = t?.file ?? "";
            return f && (t?.kind === "captions" || t?.kind === "subtitles" || /\.vtt(\?|$)/i.test(f));
          })
          .map((t) => ({
            label: t.label || "Subtitles",
            url: `/api/movies/subtitle-proxy?url=${encodeURIComponent(t.file ?? "")}&referer=${encodeURIComponent(mpOrigin)}`,
            srclang: trackLang(t.file ?? ""),
          }));
        const clean = (w?: SkipWindow) =>
          w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start
            ? { start: Number(w.start), end: Number(w.end) }
            : null;
        const intro = clean(j.intro);
        const outro = clean(j.outro);
        return {
          playerName: "Megaplay",
          streamUrl: `/api/movies/m3u8-proxy?url=${encodeURIComponent(file)}&referer=${encodeURIComponent(mpOrigin)}`,
          subtitles,
          ...(intro ? { intro } : {}),
          ...(outro ? { outro } : {}),
        };
      } catch {
        return null;
      }
    }
    // Direct-file players (Aniwatch's newer /play/{token} pages) skip the
    // player machinery entirely: a plain <source type="video/mp4"> that is
    // Referer-gated (403 without), so it is served through the mp4 proxy which
    // forwards Range requests for seeking.
    const mp4 =
      page.match(/<source[^>]+src=["']([^"']+)["'][^>]*type=["']video\/(?:mp4|webm|ogg)["']/) ??
      page.match(/<video[^>]+src=["']([^"']+\.(?:mp4|webm|ogg)(?:\?[^"']*)?)["']/);
    if (mp4) {
      const file = /^https?:\/\//i.test(mp4[1]) ? mp4[1] : new URL(mp4[1], pageUrl).href;
      if (await isSafeUrl(file)) {
        const mpOrigin = `${new URL(pageUrl).origin}/`;
        return {
          playerName: "Direct",
          streamUrl: `/api/movies/mp4-proxy?url=${encodeURIComponent(file)}&referer=${encodeURIComponent(mpOrigin)}`,
        };
      }
    }
    const inner = page.match(/<iframe[^>]+src=["']([^"']+)["']/)?.[1];
    if (!inner) return null;
    const next = /^https?:\/\//i.test(inner) ? inner : new URL(inner, pageUrl).href;
    if (!(await isSafeUrl(next))) return null;
    const nextHtml = await megaFetchPage(next, embedUrl);
    if (!nextHtml) return null;
    page = nextHtml;
    pageUrl = next;
  }
  return null;
}
