import { NextResponse } from "next/server";

export const runtime = "nodejs";
// Revalidate often — this is a live probe, never a cached page.
export const revalidate = 0;

interface Probe {
  ok: boolean;
  status?: number | string;
  latencyMs: number;
}

async function probeUrl(url: string, timeoutMs = 6000): Promise<Probe> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    // Any HTTP response (even 404/403) proves DNS + TCP + TLS work — the
    // domain is alive. Only 5xx / network throws count as down.
    await res.body?.cancel().catch(() => {});
    return { ok: res.status < 500, status: res.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, status: String(e).slice(0, 80), latencyMs: Date.now() - start };
  }
}

function envList(name: string, defaults: string[]): string[] {
  const raw = (process.env[name] ?? "").trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean)
    : [...defaults];
  return list.length > 0 ? list : [...defaults];
}

export async function GET() {
  const aniwatchBases = envList("ANIWATCH_BASES", ["https://aniwatch.co.at"]);
  const anikotoRaw = envList("ANIKOTO_MIRRORS", [
    "https://anikoto.cz",
    "https://anikototv.to",
    "https://anikoto.me",
    "https://anikoto.net",
  ]);
  const anikotoHosts = anikotoRaw.map((e) => e.split("|")[0].trim());
  const kenjitsuBases = envList("KENJITSU_BASES", [
    process.env.KENJITSU_BASE?.trim() || "https://kenjitsu.vercel.app",
  ]);
  const backend = (process.env.ALLANIME_BACKEND ?? "mkissa.net").trim() || "mkissa.net";
  const vidsrcDomains = envList("VIDSRC_DOMAINS", [
    "https://vidsrc.sh",
    "https://vidsrc2.ru",
    "https://vidsrc.ir",
    "https://vsembed.su",
  ]);

  const [aniwatch, anikoto, kenjitsu, allanime, vidsrc] = await Promise.all([
    (async () => {
      const out: Record<string, Probe> = {};
      for (const b of aniwatchBases) out[b] = await probeUrl(`${b}/`);
      return out;
    })(),
    (async () => {
      const out: Record<string, Probe> = {};
      for (const h of anikotoHosts) out[h] = await probeUrl(`${h}/`);
      return out;
    })(),
    (async () => {
      const out: Record<string, Probe> = {};
      for (const b of kenjitsuBases) out[b] = await probeUrl(`${b}/api/anizone/anime/search?q=naruto`);
      return out;
    })(),
    probeUrl(`https://api.${backend.replace(/^https?:\/\//, "")}/api`),
    (async () => {
      const out: Record<string, Probe> = {};
      for (const d of vidsrcDomains) out[d] = await probeUrl(`${d}/`);
      return out;
    })(),
  ]);

  const anyDown = (group: Record<string, Probe>) => Object.values(group).every((p) => !p.ok);
  const ok =
    !anyDown(aniwatch) || !anyDown(anikoto) || !anyDown(kenjitsu);

  return NextResponse.json({
    ok,
    ts: new Date().toISOString(),
    upstreams: { aniwatch, anikoto, kenjitsu, allanime, vidsrc },
    hint: "A group counts as down only when EVERY domain in it fails. If one domain is down, override via ANIWATCH_BASES / ANIKOTO_MIRRORS / KENJITSU_BASES / ALLANIME_BACKEND / VIDSRC_DOMAINS (see .env.example) and restart.",
  });
}
