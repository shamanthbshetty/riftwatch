import { NextResponse } from "next/server";
import { getTrending, getTrendingTV } from "@/lib/movies";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [movies, tv] = await Promise.all([getTrending(), getTrendingTV()]);
    return NextResponse.json({ movies, tv });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
