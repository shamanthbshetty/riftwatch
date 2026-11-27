"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import MediaCard from "@/components/MediaCard";
import EmptyState from "@/components/Skeleton";
import { removeShowFromHistory, removeFromMovieHistory } from "@/lib/storage";
import { useAllHistory, useContinueWatchingMovies } from "@/lib/useWatchlists";
import { posterUrl } from "@/lib/movies";
import { useToast } from "@/lib/toast";

export default function HistoryPage() {
  const [tab, setTab] = useState<"anime" | "movies">("anime");
  const animeItems = useAllHistory();
  const movieItems = useContinueWatchingMovies();
  const router = useRouter();
  const { toast } = useToast();

  const removeAnime = (id: string) => {
    removeShowFromHistory(id);
    toast("Removed from history");
  };

  const removeMovie = (id: string) => {
    removeFromMovieHistory(id);
    toast("Removed from history");
  };

  const tabButton = (label: string, value: "anime" | "movies") => (
    <button
      onClick={() => setTab(value)}
      className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
        tab === value ? "bg-surface-hover text-foreground" : "text-text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  const empty = tab === "anime" ? animeItems.length === 0 : movieItems.length === 0;

  return (
    <div className="max-w-7xl mx-auto page-top pb-6 px-4 md:px-8 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-text-muted hover:text-foreground transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h1 className="text-xl font-semibold">Watch History</h1>
      </div>

      <div className="flex items-center gap-2">
        {tabButton("Anime", "anime")}
        {tabButton("Movies & TV", "movies")}
      </div>

      {empty && (
        <EmptyState
          icon={
            <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          }
          title="Nothing here yet"
          description="Start watching something to build your history."
        />
      )}

      {tab === "anime" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {animeItems.map((item) => (
            <MediaCard
              key={`${item.id}-${item.ep}`}
              href={`/watch/${item.id}?ep=${item.ep}&mode=${item.mode}${item.title ? `&title=${encodeURIComponent(item.title)}` : ""}`}
              title={item.englishName || item.title}
              image={item.thumbnail}
              meta={[`EP ${item.ep}`, item.mode.toUpperCase()]}
              actions={
                <button
                  onClick={() => removeAnime(item.id)}
                  aria-label="Remove from history"
                  className="absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white/80 opacity-0 transition-[opacity,color,border-color] hover:border-red-400/60 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              }
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {movieItems.map((item) => {
            const href = `/movies/${item.id}/watch?type=${item.type}${item.type === "tv" ? `&season=${item.season ?? 1}&episode=${item.episode ?? 1}` : ""}`;
            return (
              <MediaCard
                key={`${item.id}-${item.season ?? ""}-${item.episode ?? ""}`}
                href={href}
                title={item.title}
                image={posterUrl(item.poster)}
                meta={[item.type === "tv" ? `S${item.season ?? 1} E${item.episode ?? 1}` : "MOVIE"]}
                actions={
                  <button
                    onClick={() => removeMovie(item.id)}
                    aria-label="Remove from history"
                    className="absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white/80 opacity-0 transition-[opacity,color,border-color] hover:border-red-400/60 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
