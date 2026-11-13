"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { cachedFetch } from "@/lib/cache";

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
  const dow = new Date().getDay();
  return DAYS[dow === 0 ? 6 : dow - 1];
}
const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function formatTimeJST(time: string): string {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const jstHour = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${jstHour}:${String(m).padStart(2, "0")} ${ampm}`;
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

export default function ScheduleSection() {
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
      <div className="flex items-center justify-between mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <h2 className="text-lg font-semibold section-title">Airing Schedule</h2>
        <span className="text-xs text-text-secondary">Times in JST</span>
      </div>

      <div className="flex gap-1.5 mb-4 overflow-x-auto scrollbar-hide pb-1 pl-10 md:pl-10">
        {DAYS.map((d) => (
          <button
            key={d}
              onClick={() => { setPickedDay(d); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface skeleton" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-text-muted text-sm py-6 text-center">No shows scheduled for {DAY_LABELS[activeDay]}.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {entries.map((a, i) => (
              <Link
                key={`${a.malId}-${i}`}
                href={`/anime/${a.malId}`}
                className="flex items-center gap-3 p-2.5 rounded-lg bg-surface hover:bg-surface-hover transition-colors group animate-fade-in-up"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="relative w-10 h-14 rounded overflow-hidden shrink-0 bg-surface-hover">
                  {a.thumbnail && <Image src={a.thumbnail} alt="" fill className="object-cover" unoptimized />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate group-hover:text-accent transition-colors">{a.title}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-accent font-medium">{formatTimeJST(a.time)}</span>
                    {a.score && <span className="text-[10px] text-text-secondary">★ {a.score}</span>}
                  </div>
                  {a.genres.length > 0 && (
                    <p className="text-[9px] text-text-secondary truncate mt-0.5">{a.genres.slice(0, 3).join(" · ")}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center mt-4">
              <button
                onClick={handleShowMore}
                disabled={loadingMore}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-surface hover:bg-surface-hover text-text-muted border border-border transition-colors disabled:opacity-50"
              >
                {loadingMore ? "Loading..." : "Show More"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
