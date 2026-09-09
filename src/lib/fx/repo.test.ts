import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { FALLBACK_COP_PER_USD } from "@/lib/money";
import {
  backfillTrmHistory,
  getCurrentFxRate,
  getFxRateAsOf,
  microsToRate,
  rateToMicros,
  upsertFxRate,
} from "./repo";

async function cleanup() {
  await db.execute(sql`DELETE FROM fx_rates WHERE base = 'USD' AND quote = 'COP'`);
}

describe("rateToMicros / microsToRate", () => {
  it("roundtrips typical TRM values without losing precision", () => {
    expect(microsToRate(rateToMicros(3615.1))).toBe(3615.1);
    expect(microsToRate(rateToMicros(4200.55))).toBe(4200.55);
    expect(microsToRate(rateToMicros(3999.999999))).toBe(3999.999999);
  });
});

describe("getCurrentFxRate (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns fallback when fx_rates is empty", async () => {
    const rate = await getCurrentFxRate();
    expect(rate.source).toBe("fallback");
    expect(rate.rate).toBe(FALLBACK_COP_PER_USD);
    expect(rate.fetchedAt).toBeNull();
  });

  it("returns the most recent row after upsert", async () => {
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3615.1,
      asOf: "2026-04-17",
      source: "trm",
    });
    const rate = await getCurrentFxRate();
    expect(rate.rate).toBe(3615.1);
    expect(rate.asOf).toBe("2026-04-17");
    expect(rate.source).toBe("trm");
    expect(rate.fetchedAt).toBeInstanceOf(Date);
  });

  it("upsert replaces existing row for same (base, quote, asOf)", async () => {
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3600,
      asOf: "2026-04-17",
      source: "trm",
    });
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3615.1,
      asOf: "2026-04-17",
      source: "trm",
    });
    const rate = await getCurrentFxRate();
    expect(rate.rate).toBe(3615.1);

    const countRows = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM fx_rates WHERE base='USD' AND quote='COP'`,
    );
    expect(countRows[0]?.c).toBe("1");
  });

  it("returns the latest asOf when multiple days are present", async () => {
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3600,
      asOf: "2026-04-15",
      source: "trm",
    });
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3620,
      asOf: "2026-04-17",
      source: "trm",
    });
    const rate = await getCurrentFxRate();
    expect(rate.asOf).toBe("2026-04-17");
    expect(rate.rate).toBe(3620);
  });
});

describe("getFxRateAsOf (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns null when no covering row exists (does not use the 4000 fallback)", async () => {
    const rate = await getFxRateAsOf("2026-01-14");
    expect(rate).toBeNull();
  });

  it("returns the covering rate for a weekend/holiday (asOf <= date)", async () => {
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3757.08,
      asOf: "2025-12-31",
      source: "trm",
    });
    const newYears = await getFxRateAsOf("2026-01-01");
    expect(newYears?.asOf).toBe("2025-12-31");
    expect(newYears?.rate).toBe(3757.08);

    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3655.16,
      asOf: "2026-01-15",
      source: "trm",
    });
    const stillCovered = await getFxRateAsOf("2026-01-14");
    expect(stillCovered?.asOf).toBe("2025-12-31");
    expect(stillCovered?.rate).toBe(3757.08);
  });

  it("prefers the latest asOf that still covers the requested day", async () => {
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3663.24,
      asOf: "2026-01-14",
      source: "trm",
    });
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 3655.16,
      asOf: "2026-01-15",
      source: "trm",
    });
    const onTheDay = await getFxRateAsOf("2026-01-14");
    expect(onTheDay?.asOf).toBe("2026-01-14");
    expect(onTheDay?.rate).toBe(3663.24);
  });
});

describe("backfillTrmHistory (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("upserts every published row from fetchTrmHistory", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          {
            valor: "3757.08",
            vigenciadesde: "2025-12-31T00:00:00.000",
            vigenciahasta: "2026-01-02T00:00:00.000",
          },
          {
            valor: "3663.24",
            vigenciadesde: "2026-01-14T00:00:00.000",
            vigenciahasta: "2026-01-14T00:00:00.000",
          },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await backfillTrmHistory("2026-01-01", "2026-01-14", { fetchImpl });
    expect(result.upserted).toBe(2);
    expect((await getFxRateAsOf("2026-01-01"))?.rate).toBe(3757.08);
    expect((await getFxRateAsOf("2026-01-14"))?.rate).toBe(3663.24);
  });
});
