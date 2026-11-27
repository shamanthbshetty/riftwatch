"use client";

import { useParams } from "next/navigation";

/**
 * Resolves a dynamic route segment.
 *
 * The desktop build serves dynamic pages from `_` placeholders
 * (`anime/_.html`, `watch/_.html`, ...), so the RSC payload that hydrates them
 * carries `_` as the route param. Read the real segment from the URL instead.
 * Those placeholder pages bail out to client-side rendering, so this runs
 * before anything is painted and cannot cause a hydration mismatch.
 *
 * In the browser this simply returns the value from `useParams()`.
 */
export function useRouteParam(name: string, index = 1): string {
  const params = useParams();
  const raw = params?.[name];
  const fromNext = typeof raw === "string" ? raw : "";

  if (typeof window !== "undefined") {
    const segment = window.location.pathname.split("/").filter(Boolean)[index];
    if (segment) {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    }
  }

  return fromNext;
}
