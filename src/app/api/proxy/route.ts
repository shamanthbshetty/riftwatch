import { NextRequest, NextResponse } from "next/server";
import { isSafeUrl, safeFetch, readCapped, originOf, sanitizeHeader } from "@/lib/safe-url";

export const runtime = "nodejs";

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Embed pages are HTML/JS documents; anything past this is not one.
const MAX_BODY_BYTES = 10_000_000;
const BODY_DEADLINE_MS = 20_000;

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? req.nextUrl.searchParams.get("src");
  const referer = sanitizeHeader(req.nextUrl.searchParams.get("referer") ?? "");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
  if (!(await isSafeUrl(url))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const headers: Record<string, string> = { "User-Agent": AGENT };
    if (referer) headers["Referer"] = referer;
    const origin = originOf(referer);
    if (origin) headers["Origin"] = origin;

    const res = await safeFetch(url, { headers }, { headersTimeoutMs: 15_000 });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }

    const contentType = String(res.headers.get("content-type") || "text/html");

    // Never serve upstream HTML from our origin: an attacker-controlled page
    // would execute with access to this app's localStorage (XSS-by-proxy).
    // The only caller proxies video/audio manifests; HTML means the upstream
    // handed back an embed page, which must fail over instead of rendering.
    if (contentType.includes("text/html")) {
      res.body?.cancel().catch(() => {});
      return NextResponse.json({ error: "upstream returned html" }, { status: 415 });
    }

    const body = await readCapped(res, MAX_BODY_BYTES, BODY_DEADLINE_MS);
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    // Fixed message: upstream error strings can leak internal DNS/host details.
    console.error("[api/proxy]", String(e));
    return NextResponse.json({ error: "upstream fetch failed" }, { status: 502 });
  }
}
