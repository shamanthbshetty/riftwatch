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
    const rust = process.env.RUST_PROXY_URL || "http://127.0.0.1:3001";
    return [
      // All /api/* is served by the Rust backend (single binary, no Node runtime).
      { source: "/api/:path*", destination: `${rust}/api/:path*` },
    ];
  },
};

export default nextConfig;
