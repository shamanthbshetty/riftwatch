// Ponytail: centralised API base URL for the Tauri desktop build.
//
// In the web app, fetches use relative "/api/..." paths which Next.js rewrites
// to the Rust backend (127.0.0.1:3001). In the Tauri desktop app there is no
// Next.js server, so we rewrite them to the sidecar's fixed port directly.
// This module is a no-op in the browser — the web app is completely unaffected.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function apiUrl(path: string): string {
  if (!isTauri()) return path;
  return `http://127.0.0.1:3001${path}`;
}

// Patch window.fetch once, at module load, so every existing fetch("/api/...")
// call site keeps working without modification. Only active in Tauri.
export function installFetchPatch(): void {
  if (!isTauri() || typeof window === "undefined") return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;

    if (url.startsWith("/api/")) {
      return originalFetch(`http://127.0.0.1:3001${url}`, init);
    }
    return originalFetch(input, init);
  };
}