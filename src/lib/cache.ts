// ponytail: tiny in-memory cache for client-side fetch results — survives component remounts across client navigation
const cache = new Map<string, { data: unknown; ts: number }>();
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 300;

// Evict expired entries on write; if still full, drop oldest (Map preserves
// insertion order) so long sessions cannot grow the cache without bound.
function sweep() {
  if (cache.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts >= DEFAULT_TTL) cache.delete(k);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cachedFetch<T>(url: string, ttl = DEFAULT_TTL): Promise<T> {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.ts < ttl) return Promise.resolve(entry.data as T);
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data: T) => {
      // ponytail: don't cache empty/error objects — retry on next call
      if (!data || typeof data !== "object") return data;
      const keys = Object.keys(data as Record<string, unknown>);
      if (keys.length === 0 || "error" in (data as Record<string, unknown>)) return data;
      sweep();
      cache.set(url, { data, ts: Date.now() });
      return data;
    });
}
