import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Explicit allowlist — was hostname "**", which let ANY origin ride the
    // image optimizer (open proxy for arbitrary URLs). Only full-bleed TMDB
    // backdrops actually go through the loader; thumbnails render with
    // `unoptimized` and bypass this check entirely.
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "https", hostname: "s4.anilist.co" },
      { protocol: "https", hostname: "media.kitsu.io" },
    ],
  },
  allowedDevOrigins: ["172.28.16.1"],
  async rewrites() {
    const rust = process.env.RUST_PROXY_URL || "http://localhost:3001";
    return [
      { source: "/api/movies/m3u8-proxy", destination: `${rust}/api/movies/m3u8-proxy` },
      { source: "/api/episodes", destination: `${rust}/api/episodes` },
    ];
  },
};

export default nextConfig;
