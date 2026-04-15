import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.PGHOST ?? "/var/run/postgresql",
    database: process.env.PGDATABASE ?? "findash",
    user: process.env.PGUSER ?? process.env.USER,
    password: process.env.PGPASSWORD,
    ssl: false,
  },
  strict: true,
  verbose: true,
});
