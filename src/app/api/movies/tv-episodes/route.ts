import { NextRequest, NextResponse } from "next/server";
import { getTVTotalEpisodes } from "@/lib/movies";

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const total = await getTVTotalEpisodes(id);
    return NextResponse.json({ total });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
