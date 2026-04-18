import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";
import {
  computeIsDrift,
  DRIFT_CONFIG,
  getSmsHealthHistory,
  getSmsHealthSnapshot,
  hourInCop,
  todayInCop,
} from "./sms-health";

const TEST_USER_ID = 1;

async function cleanup() {
  await db.execute(sql`DELETE FROM ingestion_logs WHERE source = 'sms'`);
}

describe("todayInCop / hourInCop", () => {
  it("returns the COP calendar date even when UTC is already on the next day", () => {
    // 02:00 UTC on Apr 17 is 21:00 COP on Apr 16.
    const utc = new Date(Date.UTC(2026, 3, 17, 2, 0, 0));
    expect(todayInCop(utc)).toBe("2026-04-16");
    expect(hourInCop(utc)).toBe(21);
  });

  it("returns the UTC date when COP is mid-day", () => {
    // 18:00 UTC on Apr 17 is 13:00 COP on Apr 17.
    const utc = new Date(Date.UTC(2026, 3, 17, 18, 0, 0));
    expect(todayInCop(utc)).toBe("2026-04-17");
    expect(hourInCop(utc)).toBe(13);
  });
});

describe("computeIsDrift", () => {
  it("does not flag when baseline is below the floor", () => {
    expect(computeIsDrift({ todayInserted: 0, sevenDayAvgInserted: 1, nowCopHour: 23 })).toBe(
      false,
    );
  });

  it("does not flag before the evening cutoff even with zero today", () => {
    expect(
      computeIsDrift({
        todayInserted: 0,
        sevenDayAvgInserted: 10,
        nowCopHour: DRIFT_CONFIG.eveningHourCop - 1,
      }),
    ).toBe(false);
  });

  it("flags after the cutoff when today is under ratio * avg", () => {
    expect(
      computeIsDrift({
        todayInserted: 2,
        sevenDayAvgInserted: 10,
        nowCopHour: DRIFT_CONFIG.eveningHourCop,
      }),
    ).toBe(true);
  });

  it("does not flag when today meets or exceeds ratio * avg", () => {
    const threshold = 10 * DRIFT_CONFIG.ratio;
    expect(
      computeIsDrift({
        todayInserted: threshold,
        sevenDayAvgInserted: 10,
        nowCopHour: 22,
      }),
    ).toBe(false);
  });
});

describe("getSmsHealthHistory (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns an empty array when no SMS logs exist", async () => {
    const history = await getSmsHealthHistory(TEST_USER_ID, 7);
    expect(history).toEqual([]);
  });

  it("groups rows by COP calendar day and counts per status", async () => {
    // All three fall on 2026-04-17 in COP time:
    // - 13:00 UTC = 08:00 COP Apr 17
    // - 23:00 UTC = 18:00 COP Apr 17
    // - 04:00 UTC next day = 23:00 COP Apr 17
    const base = new Date(Date.UTC(2026, 3, 17, 13, 0, 0));
    const later = new Date(Date.UTC(2026, 3, 17, 23, 0, 0));
    const edge = new Date(Date.UTC(2026, 3, 18, 4, 0, 0));

    await db.insert(ingestionLogs).values([
      {
        source: "sms",
        status: "inserted",
        itemsReceived: 1,
        itemsInserted: 1,
        startedAt: base,
        finishedAt: base,
      },
      {
        source: "sms",
        status: "inserted",
        itemsReceived: 1,
        itemsInserted: 1,
        startedAt: later,
        finishedAt: later,
      },
      {
        source: "sms",
        status: "skipped",
        itemsReceived: 1,
        errorMessage: "non_transactional",
        startedAt: edge,
        finishedAt: edge,
      },
    ]);

    const now = new Date(Date.UTC(2026, 3, 18, 5, 0, 0)); // 00:00 COP Apr 18
    const history = await getSmsHealthHistory(TEST_USER_ID, 7, now);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      copDate: "2026-04-17",
      inserted: 2,
      skipped: 1,
      duplicated: 0,
      error: 0,
    });
    expect(history[0].lastSmsAt?.toISOString()).toBe(edge.toISOString());
  });

  it("ignores logs from non-sms sources", async () => {
    await db.insert(ingestionLogs).values({
      source: "manual",
      status: "inserted",
      itemsReceived: 1,
      itemsInserted: 1,
      startedAt: new Date(Date.UTC(2026, 3, 17, 13, 0, 0)),
      finishedAt: new Date(Date.UTC(2026, 3, 17, 13, 0, 0)),
    });
    const history = await getSmsHealthHistory(TEST_USER_ID, 7);
    expect(history).toEqual([]);
  });
});

describe("getSmsHealthSnapshot (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns zeros when there are no logs", async () => {
    const now = new Date(Date.UTC(2026, 3, 17, 18, 0, 0));
    const snap = await getSmsHealthSnapshot(TEST_USER_ID, now);
    expect(snap.todayInserted).toBe(0);
    expect(snap.sevenDayAvgInserted).toBe(0);
    expect(snap.lastSmsAt).toBeNull();
    expect(snap.isDrift).toBe(false);
  });

  it("averages the previous 7 COP days across calendar gaps", async () => {
    // Reference: now = 2026-04-17 18:00 COP → "today" = 2026-04-17.
    // Previous 7 days = Apr 10..Apr 16. Insert 7 rows, one per day, each 'inserted'.
    const values = [] as (typeof ingestionLogs.$inferInsert)[];
    for (let d = 10; d <= 16; d += 1) {
      const ts = new Date(Date.UTC(2026, 3, d, 18, 0, 0)); // 13:00 COP that day
      values.push({
        source: "sms",
        status: "inserted",
        itemsReceived: 1,
        itemsInserted: 1,
        startedAt: ts,
        finishedAt: ts,
      });
    }
    await db.insert(ingestionLogs).values(values);

    const now = new Date(Date.UTC(2026, 3, 17, 23, 0, 0)); // 18:00 COP Apr 17
    const snap = await getSmsHealthSnapshot(TEST_USER_ID, now);

    expect(snap.todayCopDate).toBe("2026-04-17");
    expect(snap.todayInserted).toBe(0);
    expect(snap.sevenDayAvgInserted).toBe(1);
    // 18:00 COP < evening cutoff (20) → no flag even though today is 0.
    expect(snap.isDrift).toBe(false);
  });
});
