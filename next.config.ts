import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/ bundle the CD pipeline can
  // rsync + run via `bun server.js` — no node_modules install on the droplet.
  output: "standalone",
  allowedDevOrigins: ["ia-server.tailcabcc8.ts.net"],
  // Bull-Board can't be bundled by Turbopack — @bull-board/express does
  // require('@bull-board/ui/package.json') and require.resolve() tricks
  // internally to find its UI dist. Turbopack's bundled chunks don't
  // satisfy those runtime require() calls, throwing
  // `ResolveMessage: Cannot find module '@bull-board/ui/package.json'`
  // on every request.
  //
  // Fix: externalize the 3 @bull-board packages so Node's normal resolver
  // handles them at runtime, AND copy them (plus ejs) into the standalone
  // bundle so they exist on disk in prod. (#607)
  serverExternalPackages: ["@bull-board/api", "@bull-board/express", "@bull-board/ui"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/ejs/**/*",
      "./node_modules/@bull-board/api/**/*",
      "./node_modules/@bull-board/express/**/*",
      "./node_modules/@bull-board/ui/**/*",
    ],
  },
};

export default nextConfig;
