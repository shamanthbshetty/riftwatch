import { NextRequest, NextResponse } from "next/server";
import { getAnikotoEmbeds } from "@/lib/anikoto";
import { getAniwatchEmbed } from "@/lib/aniwatch";
import { getKenjitsuStream } from "@/lib/kenjitsu";
import { getShow } from "@/lib/allanime";
import { searchReady } from "@/lib/title-score";

async function resolveShowName(id: string, fallbackTitle?: string | null): Promise<{ name: string; englishName?: string } | null> {
  if (id.startsWith("kitsu-")) {
    const kitsuId = id.replace("kitsu-", "");
    try {
      const r = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}`, {
        headers: { Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const json = await r.json();
        const attrs = json.data?.attributes;
        if (attrs) {
          const name = attrs.titles?.en || attrs.titles?.en_jp || attrs.canonicalTitle || "";
          return { name: searchReady(name), englishName: attrs.titles?.en || undefined };
        }
      }
    } catch { /* ignore */ }
    if (fallbackTitle) return { name: searchReady(fallbackTitle) };
    return null;
  }
  let show;
  try {
    show = await getShow(id);
  } catch { /* AllAnime API may be down */ }
  if (show) return { name: searchReady(show.name), englishName: show.englishName };
  // The id may be a MAL id (e.g. from the airing schedule) or an AniList id
  // rather than an AllAnime hash. Try AniList before giving up so a dead
  // AllAnime mirror doesn't 404 the whole request.
  if (/^\d+$/.test(id)) {
    try {
      for (const field of ["id", "idMal"]) {
        const res = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query($id: Int!) { Media(" + field + ": $id, type: ANIME) { title { english romaji } } }",
            variables: { id: Number(id) },
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const json = await res.json();
        const title = json.data?.Media?.title;
        const name = title?.english || title?.romaji;
        if (name) return { name: searchReady(name), englishName: title?.english || undefined };
      }
    } catch { /* ignore */ }
  }
  if (fallbackTitle) return { name: searchReady(fallbackTitle) };
  return null;
}

// Negative cache: when every provider fails for a (show, episode, mode) — often
// because an upstream search times out (Anizone has been seen hanging 15s+ on
// specific queries) — remember it briefly so repeat requests fail instantly
// instead of re-waiting every provider timeout on each page load.
const FAIL_TTL_MS = 60_000;
const FAIL_MAX = 500;
const failCache = new Map<string, number>();

function noteFailure(key: string) {
  if (failCache.size >= FAIL_MAX) {
    const oldest = failCache.keys().next().value;
    if (oldest !== undefined) failCache.delete(oldest);
  }
  failCache.set(key, Date.now());
}

// Per-provider timeout: one hanging upstream (Anizone has been seen hanging
// 15s+ on specific queries) must not stall the whole server list — the
// negative cache below already guards repeat visits.
const PROVIDER_TIMEOUT_MS = 10_000;

function withProviderTimeout<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[stream] ${label} timed out after ${PROVIDER_TIMEOUT_MS}ms`);
      resolve(fallback);
    }, PROVIDER_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const epRaw = req.nextUrl.searchParams.get("ep");
  const modeRaw = (req.nextUrl.searchParams.get("mode") ?? "sub").toLowerCase();
  const fallbackTitle = req.nextUrl.searchParams.get("title");
  if (!id || !epRaw) return NextResponse.json({ error: "id and ep required" }, { status: 400 });
  // id reaches downstream fetch URLs (kitsu path segment) — same shape gate as
  // /api/episodes so garbage ids can't be interpolated into request paths.
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  // Validate before any provider call: ep lands inside a cheerio attribute
  // selector downstream, and an arbitrary mode string would silently disable
  // the sub/dub filter (mode === "dub" would be false for "DUB").
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(epRaw)) {
    return NextResponse.json({ error: "ep must be a number" }, { status: 400 });
  }
  if (modeRaw !== "sub" && modeRaw !== "dub") {
    return NextResponse.json({ error: "mode must be sub or dub" }, { status: 400 });
  }
  const ep = epRaw;
  const mode = modeRaw as "sub" | "dub";
  const failKey = `${id}|${ep}|${mode}`;
  // The user's Retry must actually re-run the providers, not replay the
  // negative cache that got it here.
  const isRetry = Number(req.nextUrl.searchParams.get("retry") ?? "0") >= 1;
  if (!isRetry) {
    const failedAt = failCache.get(failKey);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < FAIL_TTL_MS) {
        return NextResponse.json({ error: "No sources found" }, { status: 502 });
      }
      failCache.delete(failKey);
    }
  }
  try {
    const resolved = await resolveShowName(id, fallbackTitle);
    if (!resolved) return NextResponse.json({ error: "Anime not found" }, { status: 404 });
    const show = { name: resolved.name, englishName: resolved.englishName };

    const anikotoP = getAnikotoEmbeds(show.name, ep, mode).catch((e) => {
      console.warn("[stream] anikoto failed:", String(e).slice(0, 200));
      return [];
    });
    const aniwatchP = getAniwatchEmbed(show.name, ep, mode).catch((e) => {
      console.warn("[stream] aniwatch failed:", String(e).slice(0, 200));
      return null;
    });
    // Kenjitsu's providers are sub-only (version param is a no-op) — skip the
    // 3 upstream round-trips entirely on dub requests instead of filtering later.
    const kenjitsuP = mode === "dub"
      ? Promise.resolve([])
      : getKenjitsuStream(show.name, ep, mode).catch((e) => {
          console.warn("[stream] kenjitsu failed:", String(e).slice(0, 200));
          return [];
        });

    const [anikoto, aniwatch, kenjitsu] = await Promise.all([
      withProviderTimeout(anikotoP, [], "anikoto"),
      withProviderTimeout(aniwatchP, null, "aniwatch"),
      withProviderTimeout(kenjitsuP, [], "kenjitsu"),
    ]);

    const sources: {
      sourceName: string;
      sourceUrl: string;
      type: string;
      isEmbed: boolean;
      streamUrl?: string;
      subtitles?: { label: string; url: string; srclang?: string }[];
      intro?: { start: number; end: number };
      outro?: { start: number; end: number };
    }[] = [];

    // Providers that ignore the requested audio variant (Anizone, Animeheaven)
    // would hand back Japanese audio under a DUB request, so drop them there.
    const wantsDub = mode === "dub";
    const usable = (r: { dubCapable?: boolean }) => !wantsDub || r.dubCapable === true;

    const seenMedia = new Set<string>();
    const push = (r: {
      serverName: string;
      embedUrl: string;
      streamUrl?: string;
      subtitles?: { label: string; url: string; srclang?: string }[];
      intro?: { start: number; end: number };
      outro?: { start: number; end: number };
      dubCapable?: boolean;
    }) => {
      if (!usable(r)) return;
      // Anikoto and Aniwatch routinely resolve to the identical Megaplay
      // player — listing both is fake failover (one dies, so does the other).
      // Dedupe on the actual media being served; name/url variants of the
      // same file collapse to the higher-priority server.
      const mediaKey = r.streamUrl || r.embedUrl;
      if (seenMedia.has(mediaKey)) return;
      seenMedia.add(mediaKey);
      sources.push({
        sourceName: r.serverName,
        sourceUrl: r.embedUrl,
        type: "text/html",
        isEmbed: !r.streamUrl,
        ...(r.streamUrl ? { streamUrl: r.streamUrl, subtitles: r.subtitles } : {}),
        ...(r.intro ? { intro: r.intro } : {}),
        ...(r.outro ? { outro: r.outro } : {}),
      });
    };

    // Anikoto first (user preference — its extracted "Vidstream-1" HLS carries
    // the most subtitle tracks and skip windows), Aniwatch second as failover.
    for (const k of anikoto) push(k);
    if (aniwatch) push(aniwatch);
    // Then Kenjitsu (Anizone, Animeheaven) — sub-only, so dub requests skip these
    for (const k of kenjitsu) push(k);

    if (sources.length === 0) {
      noteFailure(failKey);
      return NextResponse.json(
        { error: mode === "dub" ? "No dubbed sources available for this episode." : "No sources found" },
        { status: 502 }
      );
    }

    return NextResponse.json({ sourceUrls: sources });
  } catch (e) {
    noteFailure(failKey);
    const msg = String(e);
    const friendly = msg.includes("not found")
      ? msg
      : "Anime streaming source is currently unavailable. Try again later.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
