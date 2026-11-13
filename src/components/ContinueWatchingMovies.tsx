"use client";

import { useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { formatMediaTime, removeFromMovieHistory, type MovieHistoryItem } from "@/lib/storage";
import { useContinueWatchingMovies, useMovieResume } from "@/lib/useWatchlists";
import { useToast } from "@/lib/toast";
import Rail from "./Rail";

function ContinueMovieCard({ item, onRemove }: { item: MovieHistoryItem; onRemove: (id: string, season?: number, episode?: number) => void }) {
  const resume = useMovieResume(item.id);
  // Only show the timestamp when it belongs to this exact movie/episode.
  const matches = resume
    && resume.type === item.type
    && (resume.type === "movie" || (resume.season === item.season && resume.episode === item.episode));
  const t = matches && resume.t > 10 ? formatMediaTime(resume.t) : null;
  const where = item.type === "tv" && item.season ? `S${item.season} E${item.episode}` : "Movie";
  return (
    <div className="relative group flex-shrink-0 w-[180px]">
      <Link href={`/movies/${item.id}/watch?type=${item.type}${item.season ? `&season=${item.season}&episode=${item.episode}` : ""}`} className="block">
        <div className="relative aspect-[3/4] rounded-md overflow-hidden bg-surface card-hover">
          {item.poster ? (
            <Image
              src={item.poster}
              alt={item.title}
              fill
              sizes="180px"
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              unoptimized
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-0 left-0 right-0 p-2.5 space-y-1">
            <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{item.title}</p>
            <span className="text-[10px] font-bold bg-accent/90 text-white px-1.5 py-0.5 rounded-full inline-block">
              {where}{t ? ` · ${t}` : ""}
            </span>
          </div>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(item.id, item.season, item.episode); }}
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-surface/90 border border-border flex items-center justify-center text-text-muted hover:text-red-400 hover:border-red-400/50 opacity-0 group-hover:opacity-100 transition-[opacity,color,border-color] z-30"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </Link>
    </div>
  );
}

export default function ContinueWatchingMovies() {
  const items = useContinueWatchingMovies();
  const { toast } = useToast();

  const remove = useCallback((id: string, season?: number, episode?: number) => {
    removeFromMovieHistory(id, season, episode);
    toast("Removed from history");
  }, [toast]);

  if (items.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4 pl-10 pr-4 md:pl-10 md:pr-8">
        <h2 className="text-lg font-semibold section-title">Continue Watching</h2>
      </div>
      <Rail itemCount={items.length}>
        {items.slice(0, 7).map((item) => (
          <ContinueMovieCard key={`${item.id}-${item.season}-${item.episode}`} item={item} onRemove={remove} />
        ))}
      </Rail>
    </section>
  );
}
