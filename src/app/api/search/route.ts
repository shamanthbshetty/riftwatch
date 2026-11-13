import { NextRequest, NextResponse } from "next/server";
import { searchAnime, type SearchResult } from "@/lib/allanime";
import { searchAniList } from "@/lib/anilist";
import { normalize, scoreTitle } from "@/lib/title-score";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  try {
    // allanime first (its rows carry episodes); AniList fills the gaps —
    // upcoming shows and finished titles allanime never catalogued. allSettled
    // so one source failing still returns the other's results.
    const [aa, al] = await Promise.allSettled([searchAnime(q), searchAniList(q)]);
    // Listings only show what's released — not-yet-released titles (AniList
    // merge extras and any allanime rows flagged as such) are dropped here.
    // The Schedule section is the one place upcoming titles still appear.
    const notReleased = (r: { status?: string }) => r.status === "NOT_YET_RELEASED";
    const base = aa.status === "fulfilled" ? aa.value.filter((b) => !notReleased(b)) : [];
    const extra = al.status === "fulfilled" ? al.value.filter((e) => !notReleased(e)) : [];
    if (aa.status === "rejected" && al.status === "rejected") {
      throw aa.reason;
    }

    const seen = new Set<string>();
    for (const b of base) {
      seen.add(normalize(b.name));
      if (b.englishName) seen.add(normalize(b.englishName));
    }

    const merged: SearchResult[] = [...base];
    for (const e of extra) {
      const n = normalize(e.name);
      if (seen.has(n)) continue;
      // starts-with-level match against any allanime row = same show
      if (base.some((b) => scoreTitle(e.name, b.name) >= 700)) continue;
      seen.add(n);
      merged.push(e);
    }
    return NextResponse.json(merged);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
