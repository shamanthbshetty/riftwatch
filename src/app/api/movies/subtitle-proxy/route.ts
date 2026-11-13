import { NextRequest, NextResponse } from "next/server";
import { isSafeUrl, safeFetch, readTextCapped, originOf, sanitizeHeader } from "@/lib/safe-url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// Subtitles are small text files; anything bigger is not one.
const MAX_TEXT_BYTES = 5_000_000;
const TEXT_DEADLINE_MS = 15_000;

function assTimeToMs(t: string): number {
  const match = t.trim().match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return 0;
  const [, h, m, s, cs] = match;
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(cs) * 10;
}

function msToVttTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms2 = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms2).padStart(3, "0")}`;
}

function stripAssTags(text: string): string {
  let t = text.replace(/\{[^}]*\}/g, "");
  if (/\\p[1-9]/.test(t)) return "";
  t = t.replace(/\\p\d/g, "");
  return t.replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ").trim();
}

function srtToVtt(srt: string): string {
  const lines = srt.replace(/\r\n/g, "\n").split("\n");
  const cues: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    const numMatch = line.match(/^\d+$/);
    if (!numMatch) { i++; continue; }

    i++;
    const timeLine = (lines[i] ?? "").trim();
    i++;
    const timeMatch = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
    );
    if (!timeMatch) continue;

    const start = timeMatch[1].replace(",", ".");
    const end = timeMatch[2].replace(",", ".");
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length > 0) {
      cues.push(`${start} --> ${end}\n${textLines.join("\n")}`);
    }
    i++;
  }

  return "WEBVTT\n\n" + cues.join("\n\n");
}

function assToVtt(assContent: string): string {
  const lines = assContent.split(/\r?\n/);
  const cues: string[] = [];
  let cueIndex = 0;

  for (const line of lines) {
    const match = line.match(/^Dialogue:\s*\d+,(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),([^,]*),([^,]*),[^,]*,[^,]*,[^,]*,([^,]*),(.*)/);
    if (!match) continue;

    // Captures: 1=Start 2=End 3=Style 4=Name 5=pre-text field 6=Text.
    // The bare `[^,]*` separators (MarginL/R, Effect) are not capture groups.
    const [, start, end, , , , rawText] = match;
    if (/\\p[1-9]/.test(rawText)) continue;
    const text = stripAssTags(rawText);
    if (!text) continue;

    const startMs = assTimeToMs(start);
    const endMs = assTimeToMs(end);
    cueIndex++;

    cues.push(`${cueIndex}\n${msToVttTime(startMs)} --> ${msToVttTime(endMs)}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join("\n\n")}`;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url || !(await isSafeUrl(url))) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const referer = sanitizeHeader(req.nextUrl.searchParams.get("referer") || url);
  const origin = req.nextUrl.searchParams.get("origin") || originOf(referer) || "";

  try {
    const res = await safeFetch(
      url,
      { headers: { "User-Agent": UA, Referer: referer, Origin: origin } },
      { headersTimeoutMs: 15_000 }
    );
    if (!res.ok) return new NextResponse(`upstream ${res.status}`, { status: res.status });

    const body = await readTextCapped(res, MAX_TEXT_BYTES, TEXT_DEADLINE_MS);
    const isAss = url.includes(".ass") || body.includes("[Script Info]");
    const isSrt = url.includes(".srt") || (!isAss && /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(body));

    const vtt = isAss ? assToVtt(body) : isSrt ? srtToVtt(body) : body;

    return new NextResponse(vtt, {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (e) {
    return new NextResponse(`subtitle-proxy error: ${String(e)}`, { status: 502 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
