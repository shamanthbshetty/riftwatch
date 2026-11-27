// Desktop-only: there is no Next.js server in production, so every "/api/..."
// request is rewritten to the bundled sidecar's port.
//
// The sidecar starts with PORT=0, so the OS picks a free port (no clashes with
// a stale backend). It prints the port on stdout, Tauri stores it, and the
// frontend reads it through `get_backend_port`.

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
  return `http://127.0.0.1:${await getBackendPort()}${path}`;
}

// Synchronous variant for values rendered directly (e.g. `<video src>`). The
// port is cached by the first API fetch, which always runs before media sources.
export function backendUrl(path: string): string {
  return `http://127.0.0.1:${cachedPort ?? FALLBACK_PORT}${path}`;
}

// Backend scrapers return relative `/api/...` proxy URLs for video/subtitle
// tracks. Used as <video src>/<track src> they bypass the fetch patch, so they
// must be pointed at the sidecar explicitly. Absolute URLs are left untouched.
export function backendMediaUrl(url: string): string {
  if (!url.startsWith("/api/")) return url;
  return `http://127.0.0.1:${cachedPort ?? FALLBACK_PORT}${url}`;
}

// Installed once at module load so every fetch("/api/...") call site keeps
// working unchanged. The window guard is for Next's static prerender pass.
export function installFetchPatch(): void {
  if (typeof window === "undefined") return;
  // Start discovery immediately so `backendUrl()` is ready for media srcs.
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
