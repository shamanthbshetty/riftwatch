import { NextResponse } from "next/server";
import { getAniTrending } from "@/lib/anilist";

export async function GET() {
  try {
    const trending = await getAniTrending();
    return NextResponse.json(trending);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
