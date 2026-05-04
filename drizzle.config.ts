import { defineConfig } from "drizzle-kit";

// Match the platform-aware socket default in src/lib/db/index.ts (added in #743).
// Homebrew Postgres on macOS puts its socket at /tmp; Linux uses /var/run/postgresql.
const defaultSocket = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.PGHOST ?? defaultSocket,
    database: process.env.PGDATABASE ?? "findash",
    user: process.env.PGUSER ?? process.env.USER,
    password: process.env.PGPASSWORD,
    ssl: false,
  },
  strict: true,
  verbose: true,
});
