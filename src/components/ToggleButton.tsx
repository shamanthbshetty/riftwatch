"use client";

import { Check, Plus } from "lucide-react";

/** Small circular watchlist toggle that sits in a card's top-right corner. */
export default function ToggleButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className={`absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-sm transition-[opacity,background-color,border-color,color] focus-visible:opacity-100 group-focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 ${
        active
          ? "border-accent bg-accent text-white"
          : "border-white/25 bg-black/60 text-white/80 hover:border-white/50 hover:text-white"
      }`}
    >
      {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
