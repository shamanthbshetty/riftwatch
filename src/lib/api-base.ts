// Ponytail: centralised API base URL for the Tauri desktop build.
//
// In the web app, fetches use relative "/api/..." paths which Next.js rewrites
// to the Rust backend (127.0.0.1:3001). In the Tauri desktop app there is no
// Next.js server, so we rewrite them to the sidecar's port directly.
//
// The sidecar is started with PORT=0, so the OS picks a free port (no clashes
// with a stale backend or dev server). It prints the port on stdout, the Tauri
// shell supervisor stores it, and we fetch it through `get_backend_port`.
// This module is a no-op in the browser - the web app is unaffected.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const FALLBACK_PORT = 3001;
const PORT_TIMEOUT_MS = 15_000;

let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

async function discoverPort(): Promise<number> {
  const deadline = Date.now() + PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const port = await invoke<number | null>("get_backend_port");
      if (port) return port;
    } catch {
      // The command/plugin may not be ready yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return FALLBACK_PORT;
}

export function getBackendPort(): Promise<number> {
  if (!isTauri()) return Promise.resolve(FALLBACK_PORT);
  if (cachedPort) return Promise.resolve(cachedPort);
  if (!portPromise) {
    portPromise = discoverPort().then((port) => {
      cachedPort = port;
      return port;
    });
  }
  return portPromise;
}

export async function apiUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  return `http://127.0.0.1:${await getBackendPort()}${path}`;
}

// Synchronous variant for values that are rendered directly (e.g. `<video src>`).
// The port is cached by the first API fetch, which always runs before media
// sources are rendered. In the browser the relative path is returned untouched.
export function backendUrl(path: string): string {
  if (!isTauri()) return path;
  return `http://127.0.0.1:${cachedPort ?? FALLBACK_PORT}${path}`;
}

// The Rust scrapers return relative `/api/...` proxy URLs for video and
// subtitle tracks. As <video src>/<track src> they bypass window.fetch, so the
// fetch patch cannot rewrite them and they would resolve against the custom
// protocol origin instead of the sidecar. Leave absolute URLs untouched.
export function backendMediaUrl(url: string): string {
  if (!isTauri() || !url.startsWith("/api/")) return url;
  return `http://127.0.0.1:${cachedPort ?? FALLBACK_PORT}${url}`;
}

// Patch window.fetch once, at module load, so every existing fetch("/api/...")
// call site keeps working without modification. Only active in Tauri.
export function installFetchPatch(): void {
  if (!isTauri() || typeof window === "undefined") return;
  // Start port discovery immediately so `backendUrl()` is ready for media srcs.
  void getBackendPort();
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;

    if (url.startsWith("/api/")) {
      return originalFetch(`http://127.0.0.1:${await getBackendPort()}${url}`, init);
    }
    return originalFetch(input, init);
  };
}
