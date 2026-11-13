"use client";

import Link from "next/link";
import Image from "next/image";
import type { MovieResult } from "@/lib/movies";
import { posterUrl } from "@/lib/movies";

interface MovieCardProps {
  movie: MovieResult;
  showScore?: boolean;
  actions?: React.ReactNode;
}

export default function MovieCard({ movie, showScore, actions }: MovieCardProps) {
  const title = movie.title || movie.name || "Untitled";
  const date = movie.release_date || movie.first_air_date;
  const year = date ? new Date(date).getFullYear() : null;
  const type = movie.media_type === "tv" ? "tv" : "movie";
  const href = `/movies/${movie.id}?type=${type}`;
  const src = posterUrl(movie.poster_path);

  return (
    // Actions render as a SIBLING of the Link: an <a> wrapping a <button> is
    // invalid markup and gives keyboard/AT users two competing click targets.
    <div className="relative group">
      <Link href={href} className="block">
        <div className="relative aspect-[3/4] rounded-md bg-surface card-hover">
          <div className="absolute inset-0 rounded-md overflow-hidden">
            {src ? (
              <Image
                src={src}
                alt={title}
                fill
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                className="object-cover transition-transform duration-300 group-hover:scale-105"
                unoptimized
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No Image</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity" />
          </div>
          {showScore && movie.vote_average > 0 && (
            <span className="absolute top-1.5 left-1.5 z-10 text-[10px] font-bold bg-accent/80 text-white px-1.5 py-0.5 rounded-full">
              ★ {movie.vote_average.toFixed(1)}
            </span>
          )}
          <div className="absolute bottom-0 left-0 right-0 p-2.5 space-y-1">
            <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{title}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {year && (
                <span className="text-[10px] font-bold bg-surface/80 text-text-muted px-1.5 py-0.5 rounded-full">{year}</span>
              )}
              {type === "tv" && (
                <span className="text-[10px] font-bold bg-badge-dub/80 text-black px-1.5 py-0.5 rounded-full ml-auto">TV</span>
              )}
            </div>
          </div>
        </div>
      </Link>
      {actions}
    </div>
  );
}
