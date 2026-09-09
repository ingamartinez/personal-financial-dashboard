import { and, desc, eq, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { fxRates } from "@/lib/db/schema";
import { FALLBACK_COP_PER_USD } from "@/lib/money";
import { fetchTrmHistory } from "@/lib/fx/trm";

export type FxRate = {
  base: "USD";
  quote: "COP";
  rate: number;
  asOf: string;
  source: string;
  fetchedAt: Date | null;
};

export function rateToMicros(rate: number): bigint {
  return BigInt(Math.round(rate * 1_000_000));
}

export function microsToRate(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

export async function getCurrentFxRate(db: DB = defaultDb): Promise<FxRate> {
  const rows = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.base, "USD"), eq(fxRates.quote, "COP")))
    .orderBy(desc(fxRates.asOf), desc(fxRates.fetchedAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      base: "USD",
      quote: "COP",
      rate: FALLBACK_COP_PER_USD,
      asOf: new Date().toISOString().slice(0, 10),
      source: "fallback",
      fetchedAt: null,
    };
  }
  return {
    base: row.base as "USD",
    quote: row.quote as "COP",
    rate: microsToRate(row.rateMicros),
    asOf: row.asOf,
    source: row.source,
    fetchedAt: row.fetchedAt,
  };
}

/**
 * Covering-rate lookup: the latest published TRM with `asOf <= date`.
 * Weekends and holidays share the previous business day's row. Returns null
 * when nothing covers `asOf` — callers must not fall back to
 * FALLBACK_COP_PER_USD; a missing historical rate is a missing match, not 4000.
 */
export async function getFxRateAsOf(asOf: string, db: DB = defaultDb): Promise<FxRate | null> {
  const rows = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.base, "USD"), eq(fxRates.quote, "COP"), lte(fxRates.asOf, asOf)))
    .orderBy(desc(fxRates.asOf), desc(fxRates.fetchedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    base: row.base as "USD",
    quote: row.quote as "COP",
    rate: microsToRate(row.rateMicros),
    asOf: row.asOf,
    source: row.source,
    fetchedAt: row.fetchedAt,
  };
}

export async function backfillTrmHistory(
  fromInclusive: string,
  toInclusive: string,
  opts?: { fetchImpl?: typeof fetch; db?: DB },
): Promise<{ upserted: number }> {
  const rows = await fetchTrmHistory(fromInclusive, toInclusive, opts?.fetchImpl ?? fetch);
  const database = opts?.db ?? defaultDb;
  for (const row of rows) {
    await upsertFxRate(
      {
        base: "USD",
        quote: "COP",
        rate: row.rate,
        asOf: row.asOf,
        source: row.source,
      },
      database,
    );
  }
  return { upserted: rows.length };
}

export async function upsertFxRate(
  input: { base: "USD"; quote: "COP"; rate: number; asOf: string; source: string },
  db: DB = defaultDb,
): Promise<void> {
  const micros = rateToMicros(input.rate);
  await db
    .insert(fxRates)
    .values({
      base: input.base,
      quote: input.quote,
      rateMicros: micros,
      asOf: input.asOf,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [fxRates.base, fxRates.quote, fxRates.asOf],
      set: {
        rateMicros: micros,
        source: input.source,
        fetchedAt: new Date(),
      },
    });
}
