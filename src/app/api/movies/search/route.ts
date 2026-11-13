import { NextRequest, NextResponse } from "next/server";
import { searchMovies } from "@/lib/movies";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  const page = Number(req.nextUrl.searchParams.get("page") ?? "1");
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  try {
    const data = await searchMovies(q, page);
    const ql = q.toLowerCase();
    const filtered = (data.results ?? []).filter(
      (r: { media_type?: string }) => r.media_type === "movie" || r.media_type === "tv"
    );
    const ranked = filtered.sort((a: { title?: string; name?: string; media_type?: string }, b: { title?: string; name?: string; media_type?: string }) => {
      const an = (a.title || a.name || "").toLowerCase();
      const bn = (b.title || b.name || "").toLowerCase();
      const aExact = an === ql, bExact = bn === ql;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;
      const aStarts = an.startsWith(ql), bStarts = bn.startsWith(ql);
      if (aStarts && !bStarts) return -1;
      if (bStarts && !aStarts) return 1;
      if (aStarts && bStarts) return an.length - bn.length;
      return 0;
    });
    return NextResponse.json({ ...data, results: ranked });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
