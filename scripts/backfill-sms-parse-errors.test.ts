// #1039 — the SMS parse-error backfill must stop planning rows it can never
// insert and must turn a stall into a recorded failure.
//
// S7/S1  a candidate whose `*NNNN` is not a registered account is
//        `notRecoverable` with `account_not_registered:<last4>` and the ingest
//        pipeline is never called for it.
// S8/S2/S5  a row that never resolves is recorded as `timeout:<ms>`, the loop
//        continues, and the exit code is non-zero.
// S9/S3  one progress line per row carrying index/total/logId/outcome.
// S10/S4 `--limit` caps the attempts in one run.
// S11/S6 `--dry-run` writes nothing and a second apply plans zero.
//
// The ingest pipeline is injected (`BackfillDeps.ingest`) so a stall is
// reproducible without a seven-hour wait; the logger is mocked so the progress
// contract is observable even though Pino is silent under Vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { accounts, ingestionLogs, physicalCards, transactions, users } from "../src/lib/db/schema";
import type { IngestOutcome } from "../src/lib/ingestion/sms-pipeline";
import {
  applySmsParseErrorBackfill,
  planSmsParseErrorBackfill,
  runBackfillCli,
  type BackfillDeps,
} from "./backfill-sms-parse-errors";

const logging = vi.hoisted(() => {
  type CapturedLine = { level: string; fields: Record<string, unknown> };
  const lines: CapturedLine[] = [];
  const capture =
    (level: string) =>
    (fields: unknown, _message?: string): void => {
      lines.push({ level, fields: (fields ?? {}) as Record<string, unknown> });
    };
  return {
    lines,
    createLogger: () => ({
      debug: capture("debug"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    }),
  };
});

vi.mock("../src/lib/logger", () => ({
  logger: logging.createLogger(),
  createLogger: logging.createLogger,
  shouldPrettyPrint: () => false,
}));

const TAG = "+backfill-1039@findash.local";

// Bodies shaped exactly like the prod rows: purchases on the user's real card
// (*6126) and on the cards the user decided not to register.
const PURCHASE_ON_2091 =
  "Bancolombia: Compraste COP45.900,00 en EXITO CALLE 80 con tu T.Cred *2091, el 03/11/2026 a las 09:14";
const PURCHASE_ON_6126 =
  "Bancolombia: Compraste COP120.400,00 en CARULLA CHAPINERO con tu T.Cred *6126, el 05/11/2026 a las 18:02";
// Same card, same merchant as the prod row that stalled: the injected ingest
// never settles for this one.
const PURCHASE_ON_6126_THAT_HANGS =
  "Bancolombia: Compraste COP15.900,00 en EXITO CALLE 80 con tu T.Cred *6126, el 05/11/2026 a las 19:30";
const PURCHASE_ON_6126_SECOND =
  "Bancolombia: Compraste COP31.000,00 en PAN PA YA con tu T.Cred *6126, el 06/11/2026 a las 07:45";
const PURCHASE_ON_6126_THIRD =
  "Bancolombia: Compraste COP9.900,00 en LA ESTACION DEL PAN con tu T.Cred *6126, el 07/11/2026 a las 08:20";
// Still unreadable: stays in the inbox, never planned (S6 — unchanged).
const UNREADABLE =
  "Bancolombia: Recibiste un mensaje nuevo de tu banco. Consulta la app para mas detalles. 22/11/2026";

const STALLING_MERCHANT = "EXITO CALLE 80";

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "Backfill 1039 test",
      role: "user",
      active: true,
      googleSub: `sub-${crypto.randomUUID()}`,
    })
    .returning({ id: users.id });
  return row.id;
}

async function createCardAccount(userId: number, last4: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      institution: "Bancolombia",
      name: `TC *${last4}`,
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: { last4s: [last4] },
    })
    .returning({ id: accounts.id });
  return row.id;
}

/** Account whose last4 is ONLY on the parent physical card (#693 drift class). */
async function createPhysicalCardAccount(userId: number, last4: string): Promise<number> {
  const [card] = await db
    .insert(physicalCards)
    .values({ id: crypto.randomUUID(), userId, institution: "Bancolombia", last4 })
    .returning({ id: physicalCards.id });
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      institution: "Bancolombia",
      name: `TC *${last4}`,
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: {},
      physicalCardId: card.id,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedUnresolvedSms(userId: number, body: string): Promise<number> {
  const [row] = await db
    .insert(ingestionLogs)
    .values({
      userId,
      source: "sms",
      status: "error",
      itemsReceived: 1,
      errorMessage: "parser: unknown_pattern (ai fallback disabled)",
      payload: { sender: "Bancolombia", body, parsed: { kind: "needs_review" } },
      finishedAt: new Date(),
    })
    .returning({ id: ingestionLogs.id });
  return row.id;
}

/** A real tx row so an injected `inserted` outcome can satisfy the FK. */
async function seedInsertedTx(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-11-05T18:02:00.000Z"),
      amountCents: BigInt(-12040000),
      currency: "COP",
      descriptionRaw: "CARULLA CHAPINERO",
      source: "sms",
      externalId: `${TAG}-${crypto.randomUUID()}`,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanup(): Promise<void> {
  const taggedUsers = sql`SELECT id FROM users WHERE email LIKE ${"%" + TAG}`;
  // `transactions` and `accounts` carry `deleted_at`, so the lint rule that
  // guards production soft deletes fires on `db.delete(...)` for them. This is
  // fixture teardown scoped to this file's tagged users — the same raw-SQL
  // shape scripts/repair-arq-received-channel.test.ts uses.
  await db.execute(sql`DELETE FROM ingestion_logs WHERE user_id IN (${taggedUsers})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${taggedUsers})`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id IN (${taggedUsers})`);
  await db.execute(sql`DELETE FROM physical_cards WHERE user_id IN (${taggedUsers})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${taggedUsers})`);
}

function progressLines() {
  return logging.lines.filter((line) => line.fields.event === "sms_parse_error_backfill_row");
}

/** Ingest stub that stalls on the EXITO row and inserts everything else. */
function stallingIngest(txId: number): BackfillDeps["ingest"] {
  return async (_userId, parsed) => {
    if (parsed.kind === "purchase" && parsed.merchant === STALLING_MERCHANT) {
      return new Promise<IngestOutcome>(() => {
        /* never settles — this is the prod stall */
      });
    }
    return { status: "inserted", txId };
  };
}

beforeEach(() => {
  logging.lines.length = 0;
});

afterEach(cleanup);

describe("#1039 S7 — plan skips rows whose card is not registered", () => {
  it("S7: marks an unregistered *NNNN notRecoverable and never ingests it", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    const unregisteredLogId = await seedUnresolvedSms(userId, PURCHASE_ON_2091);
    const registeredLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);

    const plan = await planSmsParseErrorBackfill({ userId });

    expect(plan.rows.map((row) => row.logId)).toEqual([registeredLogId]);
    expect(plan.notRecoverable).toBe(1);
    expect(plan.notRecoverableDetails).toEqual([
      { logId: unregisteredLogId, userId, reason: "account_not_registered:2091" },
    ]);

    const txId = await seedInsertedTx(userId, accountId);
    const ingest = vi.fn(async (): Promise<IngestOutcome> => ({ status: "inserted", txId }));
    const report = await applySmsParseErrorBackfill({ userId }, { ingest });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ planned: 1, inserted: 1, failed: 0, timedOut: 0 });

    // The unregistered row is not attempted and stays unresolved for the inbox.
    const [stillOpen] = await db
      .select()
      .from(ingestionLogs)
      .where(eq(ingestionLogs.id, unregisteredLogId));
    expect(stillOpen.resolvedAt).toBeNull();
    expect(stillOpen.resolution).toBeNull();
  });

  it("S1: resolves the last4 against THAT user's accounts only", async () => {
    const ownerUserId = await createUser();
    const otherUserId = await createUser();
    // The card exists — but for a different user. Planning for `ownerUserId`
    // must not treat it as registered.
    await createCardAccount(otherUserId, "2091");
    const logId = await seedUnresolvedSms(ownerUserId, PURCHASE_ON_2091);

    const plan = await planSmsParseErrorBackfill({ userId: ownerUserId });

    expect(plan.rows).toEqual([]);
    expect(plan.notRecoverableDetails).toEqual([
      { logId, userId: ownerUserId, reason: "account_not_registered:2091" },
    ]);
  });

  it("S1: resolves a last4 that lives only on the parent physical card", async () => {
    const userId = await createUser();
    await createPhysicalCardAccount(userId, "6126");
    const logId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);

    const plan = await planSmsParseErrorBackfill({ userId });

    expect(plan.rows.map((row) => row.logId)).toEqual([logId]);
    expect(plan.notRecoverable).toBe(0);
  });

  it("S6: an unreadable body is still counted, never planned", async () => {
    const userId = await createUser();
    await createCardAccount(userId, "6126");
    const logId = await seedUnresolvedSms(userId, UNREADABLE);

    const plan = await planSmsParseErrorBackfill({ userId });

    expect(plan.rows).toEqual([]);
    expect(plan.notRecoverableDetails).toEqual([
      { logId, userId, reason: "needs_review:unknown_pattern" },
    ]);
  });
});

describe("#1039 S8 — a stall is recorded, not waited on", () => {
  it("S8: records timeout:<ms>, keeps looping, and exits non-zero", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    const hungLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126_THAT_HANGS);
    const secondLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);
    const txId = await seedInsertedTx(userId, accountId);

    const startedAt = Date.now();
    const result = await runBackfillCli([`--user-id=${userId}`, "--timeout-ms=150"], {
      ingest: stallingIngest(txId),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.report).toMatchObject({
      planned: 2,
      inserted: 1,
      failed: 1,
      timedOut: 1,
    });
    expect(result.report?.failures).toEqual([{ logId: hungLogId, reason: "timeout:150" }]);
    // The loop proceeded to the second row instead of blocking on the first.
    expect(elapsedMs).toBeLessThan(5_000);
    // S5: a stall cannot be mistaken for success.
    expect(result.exitCode).toBe(1);

    const [stillOpen] = await db
      .select()
      .from(ingestionLogs)
      .where(eq(ingestionLogs.id, hungLogId));
    expect(stillOpen.resolvedAt).toBeNull();
    const [resolved] = await db
      .select()
      .from(ingestionLogs)
      .where(eq(ingestionLogs.id, secondLogId));
    expect(resolved.resolution).toBe("retried_success");
    expect(resolved.resolvedTxnId).toBe(txId);
  });

  it("S5: exits zero when no row timed out", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    await seedUnresolvedSms(userId, PURCHASE_ON_6126);
    const txId = await seedInsertedTx(userId, accountId);

    const result = await runBackfillCli([`--user-id=${userId}`], {
      ingest: async (): Promise<IngestOutcome> => ({ status: "inserted", txId }),
    });

    expect(result.report).toMatchObject({ planned: 1, inserted: 1, timedOut: 0 });
    expect(result.exitCode).toBe(0);
  });
});

describe("#1039 S9 — progress is observable per row", () => {
  it("S9: one line per row carrying index, total, logId and outcome", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    const firstLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126_THAT_HANGS);
    const secondLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);
    const txId = await seedInsertedTx(userId, accountId);

    await applySmsParseErrorBackfill({ userId, timeoutMs: 150 }, { ingest: stallingIngest(txId) });

    const progress = progressLines();
    expect(progress).toHaveLength(2);
    expect(progress.map((line) => line.fields.index)).toEqual([1, 2]);
    expect(progress.map((line) => line.fields.total)).toEqual([2, 2]);
    expect(progress.map((line) => line.fields.logId)).toEqual([firstLogId, secondLogId]);
    expect(progress.map((line) => line.fields.outcome)).toEqual(["timeout", "inserted"]);

    // Exactly one line per row: no second (duplicate) line for either log.
    const perRow = logging.lines.filter(
      (line) => line.fields.logId === firstLogId || line.fields.logId === secondLogId,
    );
    expect(perRow).toHaveLength(2);
  });
});

describe("#1039 S10 — --limit caps the attempts", () => {
  it("S10: attempts only `--limit` rows and defers the rest", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    const firstLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);
    const secondLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126_SECOND);
    const thirdLogId = await seedUnresolvedSms(userId, PURCHASE_ON_6126_THIRD);
    const txId = await seedInsertedTx(userId, accountId);

    const ingest = vi.fn(async (): Promise<IngestOutcome> => ({ status: "inserted", txId }));
    const result = await runBackfillCli([`--user-id=${userId}`, "--limit=2"], { ingest });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(result.report).toMatchObject({ planned: 2, inserted: 2, deferred: 1 });

    // Only the first two rows were attempted; the third is still unresolved.
    const stillOpen = await db
      .select({ id: ingestionLogs.id })
      .from(ingestionLogs)
      .where(and(eq(ingestionLogs.userId, userId), isNull(ingestionLogs.resolvedAt)))
      .orderBy(asc(ingestionLogs.id));
    expect(stillOpen.map((row) => row.id)).toEqual([thirdLogId]);

    const resolved = await db
      .select({ id: ingestionLogs.id })
      .from(ingestionLogs)
      .where(eq(ingestionLogs.userId, userId))
      .orderBy(asc(ingestionLogs.id));
    expect(resolved.map((row) => row.id)).toEqual([firstLogId, secondLogId, thirdLogId]);
  });
});

describe("#1039 S11 — dry run and idempotency", () => {
  it("S11: --dry-run performs no writes, then a second apply plans zero", async () => {
    const userId = await createUser();
    const accountId = await createCardAccount(userId, "6126");
    const logId = await seedUnresolvedSms(userId, PURCHASE_ON_6126);
    await seedUnresolvedSms(userId, PURCHASE_ON_2091);
    const txId = await seedInsertedTx(userId, accountId);

    const dryIngest = vi.fn(async (): Promise<IngestOutcome> => ({ status: "inserted", txId }));
    const dry = await runBackfillCli([`--user-id=${userId}`, "--dry-run"], {
      ingest: dryIngest,
    });

    expect(dryIngest).not.toHaveBeenCalled();
    expect(dry.report).toBeNull();
    expect(dry.plan?.rows.map((row) => row.logId)).toEqual([logId]);
    expect(dry.exitCode).toBe(0);

    // No writes at all: no tx, no resolution, no counters moved.
    const txsAfterDryRun = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(txsAfterDryRun.map((row) => row.id)).toEqual([txId]);
    const [stillOpen] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, logId));
    expect(stillOpen.resolvedAt).toBeNull();
    expect(stillOpen.itemsInserted).toBe(0);

    const deps: BackfillDeps = {
      ingest: async (): Promise<IngestOutcome> => ({ status: "inserted", txId }),
    };
    const first = await runBackfillCli([`--user-id=${userId}`], deps);
    expect(first.report).toMatchObject({ planned: 1, inserted: 1 });

    const second = await runBackfillCli([`--user-id=${userId}`], deps);
    expect(second.report).toMatchObject({ planned: 0, inserted: 0, failed: 0 });
    expect(second.plan?.rows).toEqual([]);
  });
});
