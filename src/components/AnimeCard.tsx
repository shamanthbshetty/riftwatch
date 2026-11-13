"use client";

import Link from "next/link";
import Image from "next/image";

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
  actions?: React.ReactNode;
}

export default function AnimeCard({ id, title, englishName, thumbnail, sub, dub, episode, status, score, actions }: AnimeCardProps) {
  return (
    // Actions render as a SIBLING of the Link: an <a> wrapping a <button> is
    // invalid markup and gives keyboard/AT users two competing click targets.
    <div className="relative group">
      <Link href={episode ? `/watch/${id}?ep=${episode}&mode=sub${title ? `&title=${encodeURIComponent(title)}` : ""}` : `/anime/${id}`} className="block">
        <div className="relative aspect-[3/4] rounded-md bg-surface card-hover">
          <div className="absolute inset-0 rounded-md overflow-hidden">
            {thumbnail ? (
              <Image
                src={thumbnail}
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
          <div className="absolute bottom-0 left-0 right-0 p-2.5 space-y-1">
            <p className="text-xs font-semibold text-white line-clamp-2 leading-tight">{englishName || title}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {sub !== undefined && sub > 0 && (
                <span className="text-[10px] font-bold bg-badge-sub/90 text-white px-1.5 py-0.5 rounded-full">SUB {sub}</span>
              )}
              {dub !== undefined && dub > 0 && (
                <span className="text-[10px] font-bold bg-badge-dub/90 text-black px-1.5 py-0.5 rounded-full">DUB {dub}</span>
              )}
              {status === "NOT_YET_RELEASED" && (
                <span className="text-[10px] font-bold bg-amber-500/90 text-black px-1.5 py-0.5 rounded-full">Upcoming</span>
              )}
              {score != null && score > 0 && (
                <span className="text-[10px] font-bold bg-accent/80 text-white px-1.5 py-0.5 rounded-full">★ {score}</span>
              )}
              <span className="text-[10px] font-bold bg-accent/80 text-white px-1.5 py-0.5 rounded-full ml-auto">HD</span>
            </div>
          </div>
        </div>
      </Link>
      {actions}
    </div>
  );
}
