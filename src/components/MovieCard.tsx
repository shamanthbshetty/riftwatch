"use client";

import type { MovieResult } from "@/lib/movies";
import { posterUrl } from "@/lib/movies";
import MediaCard from "./MediaCard";

interface MovieCardProps {
  movie: MovieResult;
  showScore?: boolean;
  rank?: number;
  actions?: React.ReactNode;
  className?: string;
}

export default function MovieCard({ movie, showScore, rank, actions, className }: MovieCardProps) {
  const title = movie.title || movie.name || "Untitled";
  const date = movie.release_date || movie.first_air_date;
  const year = date ? new Date(date).getFullYear() : null;
  const type = movie.media_type === "tv" ? "tv" : "movie";

  const meta: string[] = [];
  if (year) meta.push(String(year));
  meta.push(type === "tv" ? "Series" : "Film");

  return (
    <MediaCard
      href={`/movies/${movie.id}?type=${type}`}
      title={title}
      image={posterUrl(movie.poster_path)}
      score={showScore ? movie.vote_average : null}
      rank={rank}
      meta={meta}
      actions={actions}
      className={className}
    />
  );
}
