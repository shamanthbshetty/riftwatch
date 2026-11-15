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
 * when the content actually overflows (observed, not guessed), and vanish
 * when scrolled to either end so you never get a dead arrow.
 */
export default function Rail({ children, itemCount = 0 }: { children: ReactNode; itemCount?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const update = () => {
    const el = scrollRef.current;
    if (!el) return;
    setOverflow(el.scrollWidth > el.clientWidth + 8);
    setAtStart(el.scrollLeft <= 4);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    el.addEventListener("scroll", update, { passive: true });

    // Hold-and-drag to scroll horizontally with momentum.
    let isDown = false;
    let startX = 0;
    let scrollStart = 0;
    let moved = false;
    let velocity = 0;
    let lastX = 0;
    let lastTime = 0;
    let momentumRaf = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = 0; }
      isDown = true;
      moved = false;
      startX = e.clientX;
      scrollStart = el.scrollLeft;
      lastX = e.clientX;
      lastTime = performance.now();
      velocity = 0;
      el.setPointerCapture(e.pointerId);
      el.style.userSelect = "none";
    };
    const onMove = (e: PointerEvent) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = scrollStart - dx;
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = (e.clientX - lastX) / dt;
        lastX = e.clientX;
        lastTime = now;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!isDown) return;
      isDown = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      el.style.userSelect = "";

      let v = velocity * 16;
      const decay = 0.92;
      const minV = 0.5;
      const step = () => {
        if (Math.abs(v) < minV) { momentumRaf = 0; return; }
        el.scrollLeft -= v;
        v *= decay;
        momentumRaf = requestAnimationFrame(step);
      };
      if (Math.abs(v) >= minV) {
        momentumRaf = requestAnimationFrame(step);
      }
    };
    const onUpCancel = (e: PointerEvent) => {
      if (!isDown) return;
      isDown = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      el.style.userSelect = "";
      velocity = 0;
    };
    // Prevent click-through on cards after a drag.
    const onClickCapture = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUpCancel);
    el.addEventListener("click", onClickCapture, true);

    return () => {
      cancelAnimationFrame(raf);
      if (momentumRaf) cancelAnimationFrame(momentumRaf);
      ro.disconnect();
      window.removeEventListener("resize", update);
      el.removeEventListener("scroll", update);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUpCancel);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, [itemCount]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="relative group/rail">
      <div ref={scrollRef} className="carousel-scroll" draggable={false}>
        {children}
      </div>
      {overflow && !atStart && (
        <button
          aria-label="Scroll left"
          onClick={() => scrollBy(-1)}
          className="absolute left-0 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white/80 opacity-0 backdrop-blur-sm transition-[opacity,background-color,color] hover:bg-black/85 hover:text-white focus-visible:opacity-100 group-hover/rail:opacity-100"
        >
          <Chevron dir="left" />
        </button>
      )}
      {overflow && !atEnd && (
        <button
          aria-label="Scroll right"
          onClick={() => scrollBy(1)}
          className="absolute right-0 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white/80 opacity-0 backdrop-blur-sm transition-[opacity,background-color,color] hover:bg-black/85 hover:text-white focus-visible:opacity-100 group-hover/rail:opacity-100"
        >
          <Chevron dir="right" />
        </button>
      )}
    </div>
  );
}
