"use client";

// Ponytail: runs once on the client. In Tauri mode, patches window.fetch so
// relative "/api/..." calls reach the sidecar backend, and forces full page
// loads for dynamic routes (the static export only has `_` placeholders).
// No-op in the browser.
import { installFetchPatch, isTauri } from "@/lib/api-base";
import { isDynamicAppPath } from "@/lib/tauri-router";

installFetchPatch();

if (isTauri() && typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as Element | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;

      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || !isDynamicAppPath(href)) return;

      event.preventDefault();
      event.stopPropagation();
      window.location.assign(href);
    },
    true,
  );
}

export default function TauriBootstrap() {
  return null;
}
