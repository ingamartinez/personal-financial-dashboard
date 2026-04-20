import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { parserEvents, sloAlerts, type ParserEventKind } from "@/lib/db/schema";
import {
  ALERT_MIN_SAMPLES,
  SLO_ALERTS,
  checkAndAlertSlos,
  decideSloAction,
  type SloAlertConfig,
} from "./slo-alerts";

const parseSuccessCfg: SloAlertConfig = SLO_ALERTS.find((c) => c.key === "parse_success")!;

function computed(rate: number | null, samples: number) {
  return { rate, samples };
}

describe("decideSloAction", () => {
  it("no-ops when there are no samples", () => {
    const d = decideSloAction(parseSuccessCfg, computed(null, 0), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("insufficient_samples");
  });

  it("no-ops when samples are below minimum", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.5, ALERT_MIN_SAMPLES - 1), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("insufficient_samples");
  });

  it("no-ops when healthy and no active alert", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.98, 200), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("healthy");
  });

  it("fires when rate dips below target and no alert is active", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.9, 200), null);
    expect(d.action).toBe("fire");
    if (d.action === "fire") {
      expect(d.rate).toBe(0.9);
      expect(d.target).toBe(parseSuccessCfg.target);
      expect(d.samples).toBe(200);
    }
  });

  it("does not re-fire when an alert is already active (dedup)", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.9, 200), { id: 42 });
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("already_alerted");
  });

  it("resolves an active alert when rate recovers to target", () => {
    const d = decideSloAction(parseSuccessCfg, computed(parseSuccessCfg.target, 200), { id: 42 });
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") expect(d.alertId).toBe(42);
  });

  it("resolves when rate recovers above target", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.99, 200), { id: 7 });
    expect(d.action).toBe("resolve");
  });

  it("treats rate exactly at target as healthy", () => {
    const d = decideSloAction(parseSuccessCfg, computed(parseSuccessCfg.target, 200), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("healthy");
  });

  it("fires at exact min-samples boundary when below target", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.5, ALERT_MIN_SAMPLES), null);
    expect(d.action).toBe("fire");
  });

  it("does not resolve a healthy SLO that has no open alert", () => {
    const d = decideSloAction(parseSuccessCfg, computed(0.99, 200), null);
    expect(d.action).toBe("noop");
    if (d.action === "noop") expect(d.reason).toBe("healthy");
  });
});

// Integration: exercises the full orchestrator against the test DB. Telegram
// dispatch will return "no_admin" / "no_bot" because the test DB has no admin
// with a configured bot — that's fine, we only care about state transitions
// on slo_alerts here. The dispatch path itself is covered by canary-alerts
// tests and by manual staging smoke.
const TEST_USER_ID = 1;

async function cleanup() {
  await db.execute(sql`DELETE FROM parser_events WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM slo_alerts WHERE slo_key = 'parse_success'`);
}

async function seedEvent(kind: ParserEventKind, minutesAgo: number): Promise<void> {
  const createdAt = new Date(Date.now() - minutesAgo * 60 * 1000);
  await db.insert(parserEvents).values({
    userId: TEST_USER_ID,
    source: "sms",
    eventKind: kind,
    regexOutcome: { kind: "slo-alerts-test", raw: "slo-alerts-test" },
    latencyMs: 0,
    createdAt,
  });
}

describe("checkAndAlertSlos — fire/resolve cycle", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("fires when parse-success is below target with enough samples", async () => {
    // 70% over 25 samples in the last hour → below the 95% target.
    for (let i = 0; i < 18; i++) await seedEvent("parse_outcome_success", 30);
    for (let i = 0; i < 7; i++) await seedEvent("parse_needs_review", 30);

    const [decision] = await checkAndAlertSlos();
    expect(decision.action).toBe("fire");

    const rows = await db.select().from(sloAlerts).where(eq(sloAlerts.sloKey, "parse_success"));
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();
    expect(Number(rows[0].rate)).toBeCloseTo(0.72, 2);
    expect(rows[0].samples).toBe(25);
  });

  it("does not re-fire on subsequent ticks while the alert is unresolved", async () => {
    for (let i = 0; i < 18; i++) await seedEvent("parse_outcome_success", 30);
    for (let i = 0; i < 7; i++) await seedEvent("parse_needs_review", 30);

    const [first] = await checkAndAlertSlos();
    expect(first.action).toBe("fire");

    const [second] = await checkAndAlertSlos();
    expect(second.action).toBe("noop");
    if (second.action === "noop") expect(second.reason).toBe("already_alerted");

    const rows = await db.select().from(sloAlerts).where(eq(sloAlerts.sloKey, "parse_success"));
    expect(rows).toHaveLength(1);
  });

  it("resolves the open alert when rate recovers above target", async () => {
    // Fire first.
    for (let i = 0; i < 18; i++) await seedEvent("parse_outcome_success", 30);
    for (let i = 0; i < 7; i++) await seedEvent("parse_needs_review", 30);
    await checkAndAlertSlos();

    // Flood successes so the rolling rate lifts above 95%.
    for (let i = 0; i < 200; i++) await seedEvent("parse_outcome_success", 15);

    const [decision] = await checkAndAlertSlos();
    expect(decision.action).toBe("resolve");

    const rows = await db.select().from(sloAlerts).where(eq(sloAlerts.sloKey, "parse_success"));
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).not.toBeNull();
  });

  it("no-ops with insufficient samples — does not fire on a quiet weekend", async () => {
    // 3 failures out of 3 — 0% rate, but sample count below the minimum.
    for (let i = 0; i < 3; i++) await seedEvent("parse_needs_review", 30);

    const [decision] = await checkAndAlertSlos();
    expect(decision.action).toBe("noop");
    if (decision.action === "noop") expect(decision.reason).toBe("insufficient_samples");

    const rows = await db.select().from(sloAlerts).where(eq(sloAlerts.sloKey, "parse_success"));
    expect(rows).toHaveLength(0);
  });

  it("excludes parse_outcome_skip from the denominator (same semantics as SLO #1)", async () => {
    // 20 successes + 100 skips → 100% rate, not 16.7%.
    for (let i = 0; i < 20; i++) await seedEvent("parse_outcome_success", 30);
    for (let i = 0; i < 100; i++) await seedEvent("parse_outcome_skip", 30);

    const [decision] = await checkAndAlertSlos();
    expect(decision.action).toBe("noop");
    if (decision.action === "noop") expect(decision.reason).toBe("healthy");
  });
});
