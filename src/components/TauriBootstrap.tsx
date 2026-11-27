"use client";

// Ponytail: runs once on the client. In Tauri mode, patches window.fetch so
// relative "/api/..." calls reach the sidecar backend, and forces full page
// loads for dynamic routes (the static export only has `_` placeholders).
// No-op in the browser.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { installFetchPatch } from "@/lib/api-base";
import { exportData } from "@/lib/storage";
import { isDynamicAppPath } from "@/lib/tauri-router";

installFetchPatch();

if (typeof window !== "undefined") {
  // Windows media keys arrive from Rust as Tauri events. Re-dispatch them as
  // keyboard events so the player's existing shortcut handler owns the logic.
  const mediaKey = (key: string, code: string) => () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
  void listen("rw-media-play-pause", mediaKey(" ", "Space"));
  void listen("rw-media-next", mediaKey("n", "KeyN"));
  void listen("rw-media-prev", mediaKey("p", "KeyP"));

  // Keep rolling local snapshots (Rust keeps the newest five).
  const autoBackup = () => {
    try { void invoke("save_auto_backup", { contents: exportData() }); } catch { /* ignore */ }
  };
  window.setInterval(autoBackup, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") autoBackup();
  });
}

if (typeof document !== "undefined") {
  // Suppress the WebView2 browser context menu. Keep native copy/paste inside
  // text fields, but no "Save link as"/"View page source" on a desktop app.
  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  });

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
