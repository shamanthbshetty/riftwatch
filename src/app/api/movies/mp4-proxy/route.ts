import { NextRequest, NextResponse } from "next/server";
import { isSafeUrl, safeFetch, originOf, sanitizeHeader } from "@/lib/safe-url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("url required", { status: 400 });
  if (!(await isSafeUrl(url))) return new NextResponse("forbidden", { status: 403 });

  const referer = sanitizeHeader(req.nextUrl.searchParams.get("referer") || "");
  const origin = originOf(referer) || "";

  const rangeHeader = req.headers.get("range");

  try {
    const fetchHeaders: Record<string, string> = {
      "User-Agent": UA,
    };
    if (referer) fetchHeaders["Referer"] = referer;
    if (origin) fetchHeaders["Origin"] = origin;
    if (rangeHeader) fetchHeaders["Range"] = sanitizeHeader(rangeHeader);

    // Headers-only timeout: cleared before the body streams, so multi-GB video
    // downloads are never cut mid-transfer.
    const res = await safeFetch(url, { headers: fetchHeaders }, { headersTimeoutMs: 15_000 });
    if (!res.ok) return new NextResponse(`upstream ${res.status}`, { status: res.status });

    const status = res.status;
    const contentType = res.headers.get("content-type") || "video/mp4";
    const contentLength = res.headers.get("content-length");
    const contentRange = res.headers.get("content-range");
    const acceptRanges = res.headers.get("accept-ranges");

    const respHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
      "Cache-Control": "public, max-age=86400",
    };
    if (contentLength) respHeaders["Content-Length"] = contentLength;
    if (contentRange) respHeaders["Content-Range"] = contentRange;
    if (acceptRanges) respHeaders["Accept-Ranges"] = acceptRanges;
    else respHeaders["Accept-Ranges"] = "bytes";

    return new NextResponse(res.body, { status, headers: respHeaders });
  } catch (e) {
    return new NextResponse(`mp4-proxy error: ${String(e)}`, { status: 502 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
    },
  });
}
