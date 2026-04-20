import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  ingestionLogs,
  parserEvents,
  type ParserEventKind,
  transactions,
} from "@/lib/db/schema";
import {
  sloClassificationRate,
  sloDataLoss,
  sloDetectionLag,
  sloOnboardingTime,
  sloParseSuccess,
  computeAllSlos,
} from "./slos";

const TEST_USER_ID = 1;
const TEST_ACCOUNT = "__slos_test_account__";
const TEST_TX_TAG = "__slos_test_tx__";

// Freeze "now" so windowed queries are deterministic.
const NOW = new Date(Date.UTC(2026, 3, 20, 12, 0, 0));
const ago = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000);

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__slos_test_tx__%'`);
  await db.execute(sql`DELETE FROM ingestion_logs WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM parser_events WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TEST_ACCOUNT}`);
}

async function seedAccount(): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId: TEST_USER_ID,
      name: TEST_ACCOUNT,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedTx(opts: {
  accountId: number;
  source: "sms" | "telegram" | "manual" | "csv";
  classificationMethod: "rule" | "ai" | "manual" | "unclassified";
  createdAt: Date;
}): Promise<void> {
  await db.insert(transactions).values({
    userId: TEST_USER_ID,
    accountId: opts.accountId,
    occurredAt: opts.createdAt,
    amountCents: BigInt(-10_000),
    currency: "COP",
    descriptionRaw: `${TEST_TX_TAG}-${opts.source}-${Math.random()}`,
    classificationMethod: opts.classificationMethod,
    source: opts.source,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
}

async function seedParserEvent(opts: {
  eventKind: ParserEventKind;
  createdAt: Date;
  source?: "sms" | "apple_pay" | "other";
}): Promise<void> {
  await db.insert(parserEvents).values({
    userId: TEST_USER_ID,
    source: opts.source ?? "sms",
    eventKind: opts.eventKind,
    regexOutcome: { kind: "slo-test", raw: "slo-test-sms" },
    latencyMs: 0,
    createdAt: opts.createdAt,
  });
}

async function seedLog(opts: {
  source: "sms" | "csv" | "apple_pay" | "manual" | "telegram";
  status: "inserted" | "duplicated" | "error" | "skipped";
  startedAt: Date;
  resolvedAt?: Date | null;
  kind?: string;
}): Promise<number> {
  const [row] = await db
    .insert(ingestionLogs)
    .values({
      userId: TEST_USER_ID,
      source: opts.source,
      status: opts.status,
      itemsReceived: 1,
      payload: { kind: opts.kind ?? "slo-test" },
      startedAt: opts.startedAt,
      finishedAt: opts.startedAt,
      resolvedAt: opts.resolvedAt ?? null,
    })
    .returning({ id: ingestionLogs.id });
  return row.id;
}

describe("sloParseSuccess — from parser_events (#329 PR2)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("green when (regex_success + ai_fallback_success) / total ≥ 95%", async () => {
    for (let i = 0; i < 18; i++)
      await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "ai_fallback_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "ai_fallback_error", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    expect(r.raw).toBeCloseTo(0.95, 5);
    expect(r.status).toBe("green");
    expect(r.drilldown).toBe("/admin/slos/events?kind=failures");
  });

  it("red when more than 5% below target", async () => {
    for (let i = 0; i < 5; i++)
      await seedParserEvent({ eventKind: "parse_needs_review", createdAt: ago(1) });
    for (let i = 0; i < 5; i++)
      await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    expect(r.raw).toBeCloseTo(0.5, 5);
    expect(r.status).toBe("red");
  });

  it("excludes parse_outcome_skip from denominator — skips are not failures", async () => {
    await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    for (let i = 0; i < 10; i++)
      await seedParserEvent({ eventKind: "parse_outcome_skip", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    // 1/1, not 1/11 — the 10 skips never enter the denominator.
    expect(r.raw).toBe(1);
  });

  it("AI fallback success counts as parse success", async () => {
    await seedParserEvent({ eventKind: "ai_fallback_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "parse_needs_review", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    expect(r.raw).toBe(0.5);
  });

  it("AI fallback low-confidence and error count as failures", async () => {
    await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "ai_fallback_low_confidence", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "ai_fallback_error", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    expect(r.raw).toBeCloseTo(1 / 3, 5);
  });

  it("filters by source=sms — apple_pay events do not pollute the SMS SLO", async () => {
    await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    await seedParserEvent({
      eventKind: "parse_needs_review",
      createdAt: ago(1),
      source: "apple_pay",
    });

    const r = await sloParseSuccess(30, NOW);
    expect(r.raw).toBe(1);
  });

  it("no-signal when window is empty", async () => {
    const r = await sloParseSuccess(7, NOW);
    expect(r.raw).toBeNull();
    expect(r.status).toBe("no-signal");
    expect(r.display).toBe("—");
  });

  it("trend has one point per day in the window", async () => {
    await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    const r = await sloParseSuccess(7, NOW);
    expect(r.trend).toHaveLength(7);
  });

  it("description surfaces the regex/AI/failure breakdown", async () => {
    for (let i = 0; i < 8; i++)
      await seedParserEvent({ eventKind: "parse_outcome_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "ai_fallback_success", createdAt: ago(1) });
    await seedParserEvent({ eventKind: "parse_needs_review", createdAt: ago(1) });

    const r = await sloParseSuccess(30, NOW);
    expect(r.description).toMatch(/regex 8/);
    expect(r.description).toMatch(/AI 1/);
    expect(r.description).toMatch(/fallos 1/);
    expect(r.description).toMatch(/10 intentos/);
  });
});

describe("sloClassificationRate", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("green when (rule+ai)/total ≥ 90%", async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < 9; i++) {
      await seedTx({ accountId, source: "sms", classificationMethod: "rule", createdAt: ago(1) });
    }
    await seedTx({
      accountId,
      source: "sms",
      classificationMethod: "unclassified",
      createdAt: ago(1),
    });

    const r = await sloClassificationRate(30, NOW);
    expect(r.raw).toBeCloseTo(0.9, 5);
    expect(r.status).toBe("green");
  });

  it("counts ai as automated", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", classificationMethod: "ai", createdAt: ago(1) });
    await seedTx({ accountId, source: "sms", classificationMethod: "rule", createdAt: ago(1) });
    await seedTx({
      accountId,
      source: "manual",
      classificationMethod: "manual",
      createdAt: ago(1),
    });

    const r = await sloClassificationRate(30, NOW);
    expect(r.raw).toBeCloseTo(2 / 3, 5);
  });

  it("no-signal on empty window", async () => {
    const r = await sloClassificationRate(7, NOW);
    expect(r.raw).toBeNull();
    expect(r.status).toBe("no-signal");
  });
});

describe("sloDataLoss", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("green when zero unresolved errors", async () => {
    const r = await sloDataLoss();
    expect(r.raw).toBe(0);
    expect(r.status).toBe("green");
  });

  it("yellow when 1-4 unresolved", async () => {
    await seedLog({ source: "sms", status: "error", startedAt: ago(1) });
    await seedLog({ source: "sms", status: "error", startedAt: ago(1) });

    const r = await sloDataLoss();
    expect(r.raw).toBe(2);
    expect(r.status).toBe("yellow");
  });

  it("red when 5+ unresolved", async () => {
    for (let i = 0; i < 5; i++) {
      await seedLog({ source: "sms", status: "error", startedAt: ago(1) });
    }
    const r = await sloDataLoss();
    expect(r.raw).toBe(5);
    expect(r.status).toBe("red");
  });

  it("resolved errors don't count", async () => {
    await seedLog({
      source: "sms",
      status: "error",
      startedAt: ago(1),
      resolvedAt: NOW,
    });
    const r = await sloDataLoss();
    expect(r.raw).toBe(0);
    expect(r.status).toBe("green");
  });
});

describe("sloDetectionLag", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("green when no unresolved errors exist", async () => {
    const r = await sloDetectionLag(30, NOW);
    expect(r.raw).toBe(0);
    expect(r.status).toBe("green");
  });

  it("green when oldest unresolved is <24h", async () => {
    await seedLog({ source: "sms", status: "error", startedAt: ago(0, 2) }); // 2h ago
    const r = await sloDetectionLag(30, NOW);
    expect(r.raw).toBeGreaterThan(0);
    expect(r.raw).toBeLessThan(24 * 3600);
    expect(r.status).toBe("green");
  });

  it("red when oldest unresolved is >24h by margin", async () => {
    await seedLog({ source: "sms", status: "error", startedAt: ago(3) }); // 3 days ago
    const r = await sloDetectionLag(30, NOW);
    expect(r.status).toBe("red");
  });

  it("only counts unresolved — resolved old errors don't drag the lag", async () => {
    await seedLog({
      source: "sms",
      status: "error",
      startedAt: ago(30),
      resolvedAt: ago(29),
    });
    const r = await sloDetectionLag(30, NOW);
    expect(r.raw).toBe(0);
    expect(r.status).toBe("green");
  });
});

describe("sloOnboardingTime + computeAllSlos", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("sloOnboardingTime returns no-signal when no users were created in the window", async () => {
    // Bootstrap user id=1 was created long before; using a 7-day window it
    // won't appear in the onboarding-time sample.
    const r = await sloOnboardingTime(7, NOW);
    expect(r.raw).toBeNull();
    expect(r.status).toBe("no-signal");
  });

  it("computeAllSlos fans out and returns 6 results", async () => {
    const results = await computeAllSlos(30, NOW);
    expect(results).toHaveLength(6);
    expect(results.map((r) => r.key).sort()).toEqual(
      [
        "classification_rate",
        "data_loss",
        "dedup_success",
        "detection_lag",
        "onboarding_time",
        "parse_success",
      ].sort(),
    );
  });
});
