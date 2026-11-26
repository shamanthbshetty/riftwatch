"use client";

// Ponytail: runs once on the client. In Tauri mode, patches window.fetch so
// relative "/api/..." calls reach the sidecar backend. No-op in the browser.
import { installFetchPatch } from "@/lib/api-base";

installFetchPatch();

export default function TauriBootstrap() {
  return null;
}