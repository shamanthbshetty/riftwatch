import { NextRequest, NextResponse } from "next/server";
import { getAniRelations } from "@/lib/anilist";

export async function GET(req: NextRequest) {
  const rawId = req.nextUrl.searchParams.get("id");
  const rawMal = req.nextUrl.searchParams.get("malId");
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : undefined;
  const malId = rawMal && /^\d+$/.test(rawMal) ? Number(rawMal) : undefined;

  if (!id && !malId) {
    return NextResponse.json({ relations: [] });
  }

  try {
    const relations = await getAniRelations({ id, malId });
    return NextResponse.json({ relations });
  } catch {
    return NextResponse.json({ relations: [] });
  }
}
