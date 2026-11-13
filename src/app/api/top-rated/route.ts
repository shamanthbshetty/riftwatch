import { NextResponse } from "next/server";
import { getAniTopRated } from "@/lib/anilist";

export async function GET() {
  try {
    const items = await getAniTopRated();
    return NextResponse.json(items);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
