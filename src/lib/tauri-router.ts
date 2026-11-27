"use client";

import { useMemo } from "react";
import { useRouter as useNextRouter } from "next/navigation";

// The desktop build is a static export, so every dynamic route only exists as a
// `_` placeholder (`anime/_.html`, `movies/_/watch.html`, ...). Client-side
// navigation would ask for a missing RSC payload for the real id, so in Tauri
// we force a full page load and let the custom protocol serve the placeholder.
const DYNAMIC_ROUTE = /^\/(anime|watch|movies)\/[^/?#]+/;

export function isDynamicAppPath(path: string): boolean {
  return DYNAMIC_ROUTE.test(path);
}

export function useRouter() {
  const router = useNextRouter();
  return useMemo(
    () => ({
      ...router,
      push(href: string) {
        if (isDynamicAppPath(href)) {
          window.location.assign(href);
        } else {
          router.push(href);
        }
      },
      replace(href: string) {
        if (isDynamicAppPath(href)) {
          window.location.replace(href);
        } else {
          router.replace(href);
        }
      },
    }),
    [router],
  );
}
