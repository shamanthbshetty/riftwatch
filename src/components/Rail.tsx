"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={dir === "left" ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
      />
    </svg>
  );
}

/**
 * Horizontal snap rail with hover-revealed scroll arrows. Arrows only appear
 * when the content actually overflows (observed, not guessed), so a rail that
 * fits stays clean.
 */
export default function Rail({ children, itemCount = 0 }: { children: ReactNode; itemCount?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  const check = () => {
    const el = scrollRef.current;
    if (el) setOverflow(el.scrollWidth > el.clientWidth + 8);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Deferred: measures after layout/paint, never synchronously in the effect
    // body. Re-runs when itemCount changes (cards arrived / season changed).
    const raf = requestAnimationFrame(check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener("resize", check);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [itemCount]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="relative group/rail">
      <div ref={scrollRef} className="carousel-scroll">
        {children}
      </div>
      {overflow && (
        <>
          <button
            aria-label="Scroll left"
            onClick={() => scrollBy(-1)}
            className="absolute left-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white backdrop-blur-sm opacity-0 group-hover/rail:opacity-100 transition-[opacity,background-color,color] pointer-events-auto flex items-center justify-center"
          >
            <Chevron dir="left" />
          </button>
          <button
            aria-label="Scroll right"
            onClick={() => scrollBy(1)}
            className="absolute right-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white/80 hover:text-white backdrop-blur-sm opacity-0 group-hover/rail:opacity-100 transition-[opacity,background-color,color] pointer-events-auto flex items-center justify-center"
          >
            <Chevron dir="right" />
          </button>
        </>
      )}
    </div>
  );
}
