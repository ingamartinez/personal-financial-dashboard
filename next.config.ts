import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/ bundle the CD pipeline can
  // rsync + run via `bun server.js` — no node_modules install on the droplet.
  output: "standalone",
  allowedDevOrigins: ["ia-server.tailcabcc8.ts.net"],
  // Bull-Board's @bull-board/express adapter renders the dashboard via
  // Express's res.render('index'), which lazy-requires ejs at request time.
  // Turbopack's standalone tracer does NOT follow runtime require() calls,
  // so ejs would otherwise be missing from prod's node_modules and every hit
  // on /api/admin/queues throws 500 (#607). Glob keys are interpreted as
  // patterns — `[[...slug]]` would parse as a character class, so we use
  // the global `/*` key. ejs is ~50KB, overhead trivial.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/ejs/**/*"],
  },
};

export default nextConfig;
