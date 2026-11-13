import { NextResponse } from "next/server";
import { getAniSpotlight } from "@/lib/anilist";

export async function GET() {
  try {
    const items = await getAniSpotlight();
    return NextResponse.json(items);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
