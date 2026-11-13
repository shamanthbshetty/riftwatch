"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
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
    <div className="max-w-7xl mx-auto pt-9 pb-6 px-4 md:px-8 space-y-6">
      <button onClick={() => router.back()} className="text-text-muted hover:text-foreground transition-colors">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
      </button>

      <h1 className="text-xl font-semibold">Watch History</h1>

      {items.length === 0 && (
        <div className="text-center py-20 space-y-3">
          <svg className="w-12 h-12 mx-auto text-text-secondary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-text-muted font-medium">No watch history yet</p>
          <p className="text-text-secondary text-sm">Start watching anime to build your history</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {items.map((item) => (
          <div key={`${item.id}-${item.ep}`} className="relative group">
            <Link href={`/watch/${item.id}?ep=${item.ep}&mode=${item.mode}${item.title ? `&title=${encodeURIComponent(item.title)}` : ""}`} className="block">
              <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface card-hover">
                {item.thumbnail ? (
                  <Image
                    src={item.thumbnail}
                    alt={item.title}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 20vw"
                    className="object-cover transition-transform duration-300 group-hover:scale-105"
                    unoptimized
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity" />
                <div className="absolute bottom-0 left-0 right-0 p-2.5 space-y-1">
                  <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{item.englishName || item.title}</p>
                  <span className="text-[10px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full inline-block">
                    EP {item.ep} &middot; {item.mode.toUpperCase()}
                  </span>
                </div>
              </div>
            </Link>
            {/* Sibling of the Link, not nested: an <a> wrapping a <button> is
                invalid markup and two competing click targets. */}
            <button
              onClick={() => remove(item.id)}
              className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-surface/90 border border-border flex items-center justify-center text-text-muted hover:text-red-400 hover:border-red-400/50 opacity-0 group-hover:opacity-100 transition-[opacity,color,border-color] z-30"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
