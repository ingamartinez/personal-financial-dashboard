// Production migration runner. Uses drizzle-orm's runtime migrator so the
// droplet doesn't need drizzle-kit (dev dep). Invoked from the CD workflow
// as:  sudo -n -u findash bun migrate-prod.ts
//
// Expects:
//   - cwd at the release dir (reads ./drizzle/ for migration SQL)
//   - Postgres reachable via peer auth over /var/run/postgresql (no password)
//   - PGDATABASE env set (defaults to `findash` via src/lib/db parity)

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const client = postgres({
  host: process.env.PGHOST ?? "/var/run/postgresql",
  database: process.env.PGDATABASE ?? "findash",
  username: process.env.PGUSER ?? process.env.USER,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  password: process.env.PGPASSWORD,
  max: 1,
  prepare: false,
});

const db = drizzle(client);

console.log(
  `[migrate-prod] applying migrations from ./drizzle against ${process.env.PGDATABASE ?? "findash"}...`,
);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate-prod] done.");

await client.end();
