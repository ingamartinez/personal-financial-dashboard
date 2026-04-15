import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const client = postgres({
  host: process.env.PGHOST ?? "/var/run/postgresql",
  database: process.env.PGDATABASE ?? "findash",
  username: process.env.PGUSER ?? process.env.USER,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  password: process.env.PGPASSWORD,
  max: 10,
  idle_timeout: 20,
  prepare: false,
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
