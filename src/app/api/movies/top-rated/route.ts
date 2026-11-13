import { NextResponse } from "next/server";
import { getTopRatedMovies, getTopRatedTV } from "@/lib/movies";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [movies, tv] = await Promise.all([getTopRatedMovies(), getTopRatedTV()]);
    return NextResponse.json({ movies, tv });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
