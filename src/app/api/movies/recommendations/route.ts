import { NextRequest, NextResponse } from "next/server";
import { getRecommendations } from "@/lib/movies";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const type = req.nextUrl.searchParams.get("type") === "tv" ? "tv" : "movie";
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: "numeric id required" }, { status: 400 });
  }
  try {
    const results = await getRecommendations(Number(id), type);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
