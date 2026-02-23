import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Serve all 3D tile assets with a 1-year immutable cache.
        // On subsequent page loads the browser hits HTTP cache instead of the
        // network, so the in-memory preloader completes near-instantly.
        source: "/terra_b3dms/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
