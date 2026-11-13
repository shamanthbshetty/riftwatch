import { NextRequest, NextResponse } from "next/server";
import { getEpisodeTitles } from "@/lib/anilist";

export async function GET(req: NextRequest) {
  const malId = req.nextUrl.searchParams.get("malId");
  if (!malId) return NextResponse.json({ error: "malId required" }, { status: 400 });
  try {
    const titles = await getEpisodeTitles(malId);
    return NextResponse.json(titles);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
