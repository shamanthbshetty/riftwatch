import { NextRequest, NextResponse } from "next/server";
import { getMovieDetails, getTVDetails, getMovieCredits, getTVCredits } from "@/lib/movies";

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  const type = req.nextUrl.searchParams.get("type") ?? "movie";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const [details, credits] = await Promise.all([
      type === "tv" ? getTVDetails(id) : getMovieDetails(id),
      type === "tv" ? getTVCredits(id) : getMovieCredits(id),
    ]);
    return NextResponse.json({ ...details, cast: (credits.cast ?? []).slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
