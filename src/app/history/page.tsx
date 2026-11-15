"use client";

import { useRouter } from "next/navigation";
import MediaCard from "@/components/MediaCard";
import EmptyState from "@/components/Skeleton";
import { removeShowFromHistory } from "@/lib/storage";
import { useAllHistory } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";

export default function HistoryPage() {
  const items = useAllHistory();
  const router = useRouter();
  const { toast } = useToast();

  // Rows are deduped per SHOW (latest episode only) — deleting just that one
  // episode row would resurrect the row at the previous episode.
  const remove = (id: string) => {
    removeShowFromHistory(id);
    toast("Removed from history");
  };

  return (
    <div className="max-w-7xl mx-auto page-top pb-6 px-4 md:px-8 space-y-6">
      <button onClick={() => router.back()} className="text-text-muted hover:text-foreground transition-colors">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>

      <h1 className="text-xl font-semibold">Watch History</h1>

      {items.length === 0 && (
        <EmptyState
          icon={
            <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          title="No watch history yet"
          description="Start watching anime to build your history."
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {items.map((item) => (
          <MediaCard
            key={`${item.id}-${item.ep}`}
            href={`/watch/${item.id}?ep=${item.ep}&mode=${item.mode}${item.title ? `&title=${encodeURIComponent(item.title)}` : ""}`}
            title={item.englishName || item.title}
            image={item.thumbnail}
            meta={[`EP ${item.ep}`, item.mode.toUpperCase()]}
            actions={
              <button
                onClick={() => remove(item.id)}
                aria-label="Remove from history"
                className="absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white/80 opacity-0 transition-[opacity,color,border-color] hover:border-red-400/60 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
