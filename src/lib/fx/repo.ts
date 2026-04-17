import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { fxRates } from "@/lib/db/schema";
import { FALLBACK_COP_PER_USD } from "@/lib/money";

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
