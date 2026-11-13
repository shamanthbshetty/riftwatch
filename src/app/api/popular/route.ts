import { NextResponse } from "next/server";
import { getAniPopular } from "@/lib/anilist";

export async function GET() {
  try {
    const popular = await getAniPopular();
    return NextResponse.json(popular);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
