import { NextRequest, NextResponse } from "next/server";
import { getMovieDetails, getTVDetails } from "@/lib/movies";
import { getMovieStream } from "@/lib/movie-providers";

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  const type = req.nextUrl.searchParams.get("type") === "tv" ? "tv" : "movie";
  const rawSeason = req.nextUrl.searchParams.get("season");
  const rawEpisode = req.nextUrl.searchParams.get("episode");
  const season = rawSeason ? Number(rawSeason) : undefined;
  const episode = rawEpisode ? Number(rawEpisode) : undefined;
  // Number.isNaN(undefined) is false, so the old check let TV requests with
  // missing season/episode through as `undefined` — validate positively.
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }
  if (type === "tv") {
    if (season === undefined || episode === undefined ||
        !Number.isInteger(season) || !Number.isInteger(episode) ||
        season < 1 || episode < 1) {
      return NextResponse.json({ error: "invalid params" }, { status: 400 });
    }
  } else if ((rawSeason && !Number.isInteger(season)) || (rawEpisode && !Number.isInteger(episode))) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }

  let title = "";
  let poster: string | null = null;
  try {
    const details = type === "tv" ? await getTVDetails(id) : await getMovieDetails(id);
    title = details.title || details.name || "";
    poster = details.poster_path;
  } catch { /* title/poster not found, use fallback */ }

  try {
    const { sources, subtitles } = await getMovieStream(id, type, season, episode);

    if (sources.length === 0) {
      return NextResponse.json({ error: "no sources found" }, { status: 502 });
    }

    return NextResponse.json({ title, poster, sources, subtitles });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
