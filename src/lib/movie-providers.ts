import { envList, normalizeBase } from "./upstream";

export interface MovieSource {
  name: string;
  streamUrl?: string;
  embedUrl?: string;
  source: string;
  isEmbed?: boolean;
}

export interface MovieSubtitle {
  label: string;
  url: string;
  srclang?: string;
}

export interface MovieStreamResult {
  sources: MovieSource[];
  subtitles: MovieSubtitle[];
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

async function getVidLinkStream(
  tmdbId: number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
): Promise<{ streamUrl?: string; subtitles: MovieSubtitle[] }> {
  const path =
    type === "tv"
      ? `tv/${tmdbId}/${season}/${episode}`
      : `movie/${tmdbId}`;
  const key = process.env.VIDLINK_KEY ? `?key=${process.env.VIDLINK_KEY}` : "";
  try {
    const res = await fetch(`https://vidlink.pro/${path}${key}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      // ponytail: don't let a slow upstream block the whole page
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { subtitles: [] };
    const data = (await res.json()) as {
      sources?: { url?: string; isM3U8?: boolean }[];
      subtitles?: { url?: string; name?: string; lang?: string }[];
    };

    const sources = data.sources ?? [];
    const m3u8 =
      sources.find((s) => s.isM3U8 || (s.url ?? "").includes(".m3u8")) ??
      sources[0];
    const streamUrl = m3u8?.url;

    const subtitles: MovieSubtitle[] = (data.subtitles ?? [])
      .filter((s) => s.url)
      .map((s) => ({
        label: s.name || s.lang || "Subtitles",
        url: `/api/movies/subtitle-proxy?url=${encodeURIComponent(s.url as string)}`,
        srclang: (s.lang || "en").slice(0, 2).toLowerCase(),
      }));

    return { streamUrl, subtitles };
  } catch {
    return { subtitles: [] };
  }
}

export async function getMovieStream(
  tmdbId: number,
  type: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<MovieStreamResult> {
  const sources: MovieSource[] = [];
  const subtitles: MovieSubtitle[] = [];

  // Direct HLS stream (carries embedded + external subtitles). Tried first so
  // the in-app CC/subtitle menu is usable; iframe embeds are kept as fallback.
  // VidLink's JSON API needs a registered key — without one it 403s and wastes
  // latency on every request, so the call is skipped entirely unless configured.
  if (process.env.VIDLINK_KEY) {
    const vidlink = await getVidLinkStream(tmdbId, type, season, episode);
    if (vidlink.streamUrl) {
      const proxied = `/api/movies/m3u8-proxy?url=${encodeURIComponent(vidlink.streamUrl)}`;
      sources.push({
        name: "VidLink",
        streamUrl: proxied,
        source: "vidlink",
      });
      if (vidlink.subtitles.length > 0) {
        subtitles.push(...vidlink.subtitles);
      }
    }
  }

  // Provider status (verified in-browser, movie + TV, playback advancing):
  // vidsrc.to now serves a blank page; cinextream.net no longer resolves;
  // 2Embed's TV endpoint 403s (dead backend). vidsrc.sh/vidsrc2.ru/vidsrc.ir
  // are official VidSrc domains and vsembed.su mirrors vidsrc.ir (same
  // cloudorchestranova player backend) — kept as separate entries so one
  // domain dying doesn't take the whole provider down.
  // Override without editing source:
  //   VIDSRC_DOMAINS=https://vidsrc.sh,https://vidsrc2.ru,https://new-mirror.to
  const domains = envList("VIDSRC_DOMAINS", [
    "https://vidsrc.sh",
    "https://vidsrc2.ru",
    "https://vidsrc.ir",
    "https://vsembed.su",
  ]).map(normalizeBase);

  const KNOWN_NAMES: Record<string, string> = {
    "vidsrc.sh": "VidSrc",
    "vidsrc2.ru": "VidSrc Mirror",
    "vidsrc.ir": "VidSrc IR",
    "vsembed.su": "Vsembed",
  };
  const pushEmbed = (domain: string, path: string) => {
    let host = domain;
    try {
      host = new URL(domain).hostname;
    } catch { /* keep raw */ }
    const name = KNOWN_NAMES[host] ?? `VidSrc ${host}`;
    const source = host.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "vidsrc";
    sources.push({ name, embedUrl: `${domain}${path}`, source, isEmbed: true });
  };

  if (type === "movie") {
    for (const d of domains) pushEmbed(d, `/embed/movie/${tmdbId}`);
  } else {
    for (const d of domains) pushEmbed(d, `/embed/tv/${tmdbId}/${season}/${episode}`);
  }

  return { sources, subtitles };
}
