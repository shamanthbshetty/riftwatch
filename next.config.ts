import type { NextConfig } from "next";

// Desktop-only build: the frontend is always a static export embedded in the
// Tauri app. There is no Next.js server and no `/api/*` rewrite layer.
const nextConfig: NextConfig = {
  output: "export",
  images: {
    // The image optimizer is unavailable in a static export. Only the allowlist
    // matters for the `unoptimized` thumbnails and remote backdrops.
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "https", hostname: "s4.anilist.co" },
      { protocol: "https", hostname: "media.kitsu.io" },
    ],
  },
};

export default nextConfig;
