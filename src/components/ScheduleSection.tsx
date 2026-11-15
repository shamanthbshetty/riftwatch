"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { cachedFetch } from "@/lib/cache";
import { Star } from "lucide-react";
import EmptyState, { Skeleton } from "./Skeleton";
import SectionHeader from "./SectionHeader";

interface ScheduleEntry {
  title: string;
  time: string;
  malId: number;
  thumbnail: string;
  score: number | null;
  genres: string[];
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// getDay() is 0=Sunday, which sits last in DAYS.
// Evaluated per-read (not a module constant): the module-level value froze the
// day from the first import, so the "today" highlight went stale after
// midnight, and a server/client date mismatch could cause hydration trouble.
const noopSubscribe = () => () => {};
function currentDay(): string {
  // JST is UTC+9. Convert "now" to JST to pick the right day.
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dow = jst.getUTCDay();
  return DAYS[dow === 0 ? 6 : dow - 1];
}
const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function formatTimeLocal(time: string): string {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  // Source times are JST (UTC+9). Convert to the viewer's local timezone.
  const now = new Date();
  const utcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h - 9, m);
  const d = new Date(utcMs);
  const hh = d.getHours();
  const mm = d.getMinutes();
  const hour12 = hh % 12 || 12;
  const ampm = hh < 12 ? "AM" : "PM";
  return `${hour12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

type DaySchedule = Record<string, { entries: ScheduleEntry[]; hasMore: boolean }>;

// Pure so both the initial load and "show more" share it, and so the effect body
// contains no direct setState call.
function entryKey(e: ScheduleEntry): string {
  return `${e.malId}|${e.time}|${e.title}`;
}

function mergeSchedule(prev: DaySchedule, data: DaySchedule, merge: boolean): DaySchedule {
  const next = { ...prev };
  for (const day of DAYS) {
    if (!data[day]) continue;
    if (merge && prev[day]) {
      // Dedupe: switching the picked day resets `page`, so the next
      // "Show More" refetches an already-merged page → duplicate rows.
      const seen = new Set(prev[day].entries.map(entryKey));
      const fresh = data[day].entries.filter((e) => !seen.has(entryKey(e)));
      next[day] = { entries: [...prev[day].entries, ...fresh], hasMore: data[day].hasMore };
    } else {
      next[day] = data[day];
    }
  }
  return next;
}

export default function ScheduleSection({ compact }: { compact?: boolean }) {
  const [schedule, setSchedule] = useState<DaySchedule>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  // null = follow the default day, a string = the user picked one explicitly.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const today = useSyncExternalStore(noopSubscribe, currentDay, currentDay);

  useEffect(() => {
    let cancelled = false;
    cachedFetch<DaySchedule>("/api/schedule?page=1")
      .then((data) => {
        if (cancelled || !data || data.error) return;
        setSchedule((prev) => mergeSchedule(prev, data, false));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleShowMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    setPage(nextPage);
    cachedFetch<DaySchedule>(`/api/schedule?page=${nextPage}`)
      .then((data) => {
        if (data && !data.error) setSchedule((prev) => mergeSchedule(prev, data, true));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  // Default to today, falling back to the first day that actually has entries.
  // Deriving this keeps a manual pick sticky without an effect that has to
  // correct the stored value after the schedule arrives.
  const hasEntries = (d: string) => (schedule[d]?.entries?.length ?? 0) > 0;
  const activeDay = pickedDay ?? (hasEntries(today) ? today : DAYS.find(hasEntries) ?? today);

  const day = schedule[activeDay];
  const entries = day?.entries ?? [];
  const hasMore = day?.hasMore ?? false;

  return (
    <section>
      <SectionHeader title="Airing Schedule" />
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {DAYS.map((d) => (
          <button
            key={d}
            onClick={() => { setPickedDay(d); setPage(1); }}
            className={`rounded-chip px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
              d === activeDay
                ? "bg-accent text-white"
                : "bg-surface text-text-muted hover:bg-surface-hover hover:text-foreground"
            }`}
          >
            {DAY_LABELS[d]}
            {d === activeDay && entries.length > 0 && (
              <span className="ml-1.5 opacity-60">{entries.length}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: compact ? 4 : 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title={`Nothing scheduled for ${DAY_LABELS[activeDay]}.`} />
      ) : (
        <>
          <div className={compact ? "grid grid-cols-1 gap-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"}>
            {entries.map((a, i) => (
              <Link
                key={`${a.malId}-${i}`}
                href={`/anime/${a.malId}`}
                className="group flex items-center gap-3 rounded-control bg-surface p-2.5 transition-colors hover:bg-surface-hover animate-fade-in-up"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-control bg-background">
                  {a.thumbnail && <Image src={a.thumbnail} alt="" fill className="object-cover" unoptimized />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-accent">{a.title}</p>
                  <div className="mt-1 flex items-center gap-2 text-2xs">
                    <span className="font-medium text-accent">{formatTimeLocal(a.time)}</span>
                    {a.score && (
                      <span className="inline-flex items-center gap-1 tabular-nums text-text-secondary">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                        {a.score}
                      </span>
                    )}
                  </div>
                  {a.genres.length > 0 && (
                    <p className="mt-0.5 truncate text-2xs text-text-secondary">{a.genres.slice(0, 2).join(" · ")}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={handleShowMore}
                disabled={loadingMore}
                className="rounded-control border border-border bg-surface px-4 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
