import { NextRequest, NextResponse } from "next/server";
import { getTVEpisodes } from "@/lib/movies";

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  const season = Number(req.nextUrl.searchParams.get("season"));
  if (!id || !season) return NextResponse.json({ error: "id and season required" }, { status: 400 });
  try {
    const episodes = await getTVEpisodes(id, season);
    return NextResponse.json(episodes);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
