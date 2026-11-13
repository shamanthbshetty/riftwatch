import { NextRequest, NextResponse } from "next/server";
import { getPopularMovies, getPopularTV } from "@/lib/movies";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? "movie";
  try {
    const data = type === "tv" ? await getPopularTV() : await getPopularMovies();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
