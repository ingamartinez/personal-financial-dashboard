import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { FALLBACK_COP_PER_USD } from "@/lib/money";
import {
  getCurrentFxRate,
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
