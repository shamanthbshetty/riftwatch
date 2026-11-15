"use client";

import MediaCard from "./MediaCard";

interface AnimeCardProps {
  id: string;
  title: string;
  englishName?: string;
  thumbnail: string;
  sub?: number;
  dub?: number;
  episode?: number;
  status?: string;
  score?: number | null;
  rank?: number;
  meta?: string[];
  actions?: React.ReactNode;
  className?: string;
}

export default function AnimeCard({
  id,
  title,
  englishName,
  thumbnail,
  sub,
  dub,
  episode,
  status,
  score,
  rank,
  meta: metaOverride,
  actions,
  className,
}: AnimeCardProps) {
  const label = englishName || title;
  const eps = Math.max(sub ?? 0, dub ?? 0);
  const upcoming = status === "NOT_YET_RELEASED";
  const meta: string[] = [];
  if (eps > 0) meta.push(`${eps} EP`);
  if (metaOverride) meta.push(...metaOverride);

  return (
    <MediaCard
      href={episode ? `/watch/${id}?ep=${episode}&mode=sub${title ? `&title=${encodeURIComponent(title)}` : ""}` : `/anime/${id}`}
      title={label}
      image={thumbnail}
      score={upcoming ? null : score}
      rank={rank}
      note={upcoming ? "Upcoming" : null}
      sub={sub}
      dub={dub}
      meta={meta}
      actions={actions}
      className={className}
    />
  );
}
