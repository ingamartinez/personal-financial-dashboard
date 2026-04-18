import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/ bundle the CD pipeline can
  // rsync + run via `bun server.js` — no node_modules install on the droplet.
  output: "standalone",
  allowedDevOrigins: ["ia-server.tailcabcc8.ts.net"],
};

export default nextConfig;
