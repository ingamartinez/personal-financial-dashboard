// #1042 — dismiss the SMS parse errors that can never be recovered, and keep
// the ones that are still a signal.
//
// S7  a row whose `*NNNN` is not a registered account is dismissed; a row whose
//     body is an unknown pattern is not, and no transaction is created.
// S8  `--dry-run` writes nothing and reports the count per reason plus the
//     count left open.
// S9  a second apply dismisses zero.
// S10 rows from other sources and already-resolved rows are untouched.
//
// The classification is the backfill's (`planSmsParseErrorBackfill` +
// `notRecoverableDetails`, #1039), so these tests seed real SMS bodies and let
// the real parser decide the reason string — never a hand-written reason.
//
// The logger is mocked so the dry-run contract (per-reason counts, left open)
// is observable even though Pino is silent under Vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { accounts, ingestionLogs, transactions, users } from "../src/lib/db/schema";
import {
  applyUnrecoverableSmsDismissal,
  planUnrecoverableSmsDismissal,
  runDismissCli,
} from "./dismiss-unrecoverable-sms-errors";

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

const TAG = "+dismiss-1042@findash.local";

// Bodies shaped like the prod rows behind S1/L2: a purchase on a card the user
// decided not to register, a card on/off notice (#1036) and a body nobody can
// read yet.
const PURCHASE_ON_2091 =
  "Bancolombia: Compraste COP45.900,00 en EXITO CALLE 80 con tu T.Cred *2091, el 03/11/2026 a las 09:14";
const PURCHASE_ON_1235 =
  "Bancolombia: Compraste COP89.300,00 en CARULLA CHAPINERO con tu T.Cred *1235, el 04/11/2026 a las 12:40";
const CARD_TOGGLED_OFF =
  "Bancolombia: Apagaste tu tarjeta *2091. Puedes volver a encenderla cuando quieras.";
const UNREADABLE =
  "Bancolombia: Recibiste un mensaje nuevo de tu banco. Consulta la app para mas detalles. 22/11/2026";

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "Dismiss 1042 test",
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

type SeedLogOverrides = {
  source?: "sms" | "gmail_bancolombia";
  status?: string;
  body?: string;
  resolvedAt?: Date | null;
  resolution?: string | null;
};

async function seedLog(userId: number, overrides: SeedLogOverrides = {}): Promise<number> {
  const body = overrides.body ?? UNREADABLE;
  const [row] = await db
    .insert(ingestionLogs)
    .values({
      userId,
      source: overrides.source ?? "sms",
      status: overrides.status ?? "error",
      itemsReceived: 1,
      errorMessage: "parser: unknown_pattern (ai fallback disabled)",
      payload: { sender: "Bancolombia", body, parsed: { kind: "needs_review" } },
      finishedAt: new Date(),
      resolvedAt: overrides.resolvedAt ?? null,
      resolution: overrides.resolution ?? null,
    })
    .returning({ id: ingestionLogs.id });
  return row.id;
}

type LogRow = {
  id: number;
  resolvedAt: Date | null;
  resolvedTxnId: number | null;
  resolution: string | null;
  itemsInserted: number;
  errorMessage: string | null;
};

async function readLog(id: number): Promise<LogRow> {
  const [row] = await db
    .select({
      id: ingestionLogs.id,
      resolvedAt: ingestionLogs.resolvedAt,
      resolvedTxnId: ingestionLogs.resolvedTxnId,
      resolution: ingestionLogs.resolution,
      itemsInserted: ingestionLogs.itemsInserted,
      errorMessage: ingestionLogs.errorMessage,
    })
    .from(ingestionLogs)
    .where(eq(ingestionLogs.id, id));
  return row;
}

async function countTransactions(userId: number): Promise<number> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return rows.length;
}

async function openSmsErrors(userId: number): Promise<number[]> {
  const rows = await db
    .select({ id: ingestionLogs.id })
    .from(ingestionLogs)
    .where(
      sql`${ingestionLogs.userId} = ${userId} AND ${ingestionLogs.source} = 'sms' AND ${ingestionLogs.status} = 'error' AND ${ingestionLogs.resolvedAt} IS NULL`,
    )
    .orderBy(asc(ingestionLogs.id));
  return rows.map((row) => row.id);
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
  await db.execute(sql`DELETE FROM users WHERE id IN (${taggedUsers})`);
}

function planLines() {
  return logging.lines.filter((line) => line.fields.event === "sms_dismiss_plan");
}

beforeEach(() => {
  logging.lines.length = 0;
});

afterEach(cleanup);

describe("#1042 S7 — dismiss only the permanently-unrecoverable", () => {
  it("S7: dismisses an unregistered card, keeps an unknown pattern open, creates no transaction", async () => {
    const userId = await createUser();
    const unregisteredLogId = await seedLog(userId, { body: PURCHASE_ON_2091 });
    const unreadableLogId = await seedLog(userId, { body: UNREADABLE });

    const plan = await planUnrecoverableSmsDismissal({ userId });

    expect(plan.rows.map((row) => row.logId)).toEqual([unregisteredLogId]);
    expect(plan.countsByReason).toEqual({ "account_not_registered:2091": 1 });
    // S3: the unreadable row is the signal that stays visible.
    expect(plan.leftOpen).toBe(1);
    expect(plan.leftOpenByReason).toEqual({ "needs_review:unknown_pattern": 1 });

    // S2: nothing written before apply.
    const beforeApply = await readLog(unregisteredLogId);
    expect(beforeApply.resolution).toBeNull();
    expect(beforeApply.resolvedAt).toBeNull();

    const report = await applyUnrecoverableSmsDismissal({ userId });
    expect(report).toEqual({ dismissed: 1, leftOpen: 1 });

    const dismissed = await readLog(unregisteredLogId);
    expect(dismissed.resolution).toBe("dismissed");
    expect(dismissed.resolvedAt).not.toBeNull();
    // S2: and nothing else — no tx link, no counter moved, error text intact.
    expect(dismissed.resolvedTxnId).toBeNull();
    expect(dismissed.itemsInserted).toBe(0);
    expect(dismissed.errorMessage).toBe("parser: unknown_pattern (ai fallback disabled)");

    // S3: the unknown pattern is untouched and still the open error.
    const kept = await readLog(unreadableLogId);
    expect(kept.resolution).toBeNull();
    expect(kept.resolvedAt).toBeNull();
    expect(await openSmsErrors(userId)).toEqual([unreadableLogId]);

    // S2: dismissing never inserts a transaction.
    expect(await countTransactions(userId)).toBe(0);
  });

  it("S1: a skip:non_transactional notice is dismissed too", async () => {
    const userId = await createUser();
    await createCardAccount(userId, "2091");
    const noticeLogId = await seedLog(userId, { body: CARD_TOGGLED_OFF });

    const plan = await planUnrecoverableSmsDismissal({ userId });
    expect(plan.countsByReason).toEqual({ "skip:non_transactional": 1 });

    const report = await applyUnrecoverableSmsDismissal({ userId });
    expect(report.dismissed).toBe(1);
    expect((await readLog(noticeLogId)).resolution).toBe("dismissed");
  });
});

describe("#1042 S8 — dry run writes nothing and reports per-reason counts", () => {
  it("S8: reports each reason and the rows left open without writing", async () => {
    const userId = await createUser();
    const unregistered2091 = await seedLog(userId, { body: PURCHASE_ON_2091 });
    const unregistered1235 = await seedLog(userId, { body: PURCHASE_ON_1235 });
    const notice = await seedLog(userId, { body: CARD_TOGGLED_OFF });
    const unreadable = await seedLog(userId, { body: UNREADABLE });
    // Not a candidate (S1): other source / other status.
    const fromEmail = await seedLog(userId, { source: "gmail_bancolombia", body: UNREADABLE });
    const alreadyOk = await seedLog(userId, { status: "success", body: UNREADABLE });

    const result = await runDismissCli([`--user-id=${userId}`, "--dry-run"]);

    expect(result.report).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.plan?.rows.map((row) => row.logId)).toEqual([
      unregistered2091,
      unregistered1235,
      notice,
    ]);
    expect(result.plan?.countsByReason).toEqual({
      "account_not_registered:2091": 1,
      "account_not_registered:1235": 1,
      "skip:non_transactional": 1,
    });
    expect(result.plan?.leftOpen).toBe(1);
    expect(result.plan?.leftOpenByReason).toEqual({ "needs_review:unknown_pattern": 1 });

    // The dry run says the same thing through the logger.
    const lines = planLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].fields).toMatchObject({
      dryRun: true,
      countsByReason: result.plan?.countsByReason,
      leftOpen: 1,
      leftOpenByReason: { "needs_review:unknown_pattern": 1 },
    });

    // S8: no writes at all — every row keeps its resolution and no tx appears.
    for (const logId of [
      unregistered2091,
      unregistered1235,
      notice,
      unreadable,
      fromEmail,
      alreadyOk,
    ]) {
      const row = await readLog(logId);
      expect(row.resolution).toBeNull();
      expect(row.resolvedAt).toBeNull();
    }
    expect(await openSmsErrors(userId)).toEqual([
      unregistered2091,
      unregistered1235,
      notice,
      unreadable,
    ]);
    expect(await countTransactions(userId)).toBe(0);
  });
});

describe("#1042 S9 — idempotent", () => {
  it("S9: a second apply dismisses zero", async () => {
    const userId = await createUser();
    const unregisteredLogId = await seedLog(userId, { body: PURCHASE_ON_2091 });
    const unreadableLogId = await seedLog(userId, { body: UNREADABLE });

    const first = await applyUnrecoverableSmsDismissal({ userId });
    expect(first).toEqual({ dismissed: 1, leftOpen: 1 });

    const second = await applyUnrecoverableSmsDismissal({ userId });
    expect(second).toEqual({ dismissed: 0, leftOpen: 1 });

    const secondPlan = await planUnrecoverableSmsDismissal({ userId });
    expect(secondPlan.rows).toEqual([]);
    expect(secondPlan.countsByReason).toEqual({});
    expect(await openSmsErrors(userId)).toEqual([unreadableLogId]);

    // The row dismissed by the first run keeps its single dismissal.
    const dismissed = await readLog(unregisteredLogId);
    expect(dismissed.resolution).toBe("dismissed");
    expect(dismissed.resolvedAt).not.toBeNull();
  });
});

describe("#1042 S10 — other sources and resolved rows are untouched", () => {
  it("S10: a non-sms row, a resolved row and a non-error row keep their state", async () => {
    const userId = await createUser();
    const dismissableLogId = await seedLog(userId, { body: PURCHASE_ON_2091 });
    const fromEmail = await seedLog(userId, {
      source: "gmail_bancolombia",
      body: PURCHASE_ON_2091,
    });
    const resolvedAt = new Date("2026-11-20T15:04:05.000Z");
    const alreadyResolved = await seedLog(userId, {
      body: PURCHASE_ON_2091,
      resolvedAt,
      resolution: "retried_failed",
    });
    const nonError = await seedLog(userId, { body: PURCHASE_ON_2091, status: "success" });

    const report = await applyUnrecoverableSmsDismissal({ userId });

    // Only the sms/error/unresolved row is a candidate (S1).
    expect(report.dismissed).toBe(1);
    expect((await readLog(dismissableLogId)).resolution).toBe("dismissed");

    const emailRow = await readLog(fromEmail);
    expect(emailRow.resolution).toBeNull();
    expect(emailRow.resolvedAt).toBeNull();

    const resolvedRow = await readLog(alreadyResolved);
    expect(resolvedRow.resolution).toBe("retried_failed");
    expect(resolvedRow.resolvedAt?.toISOString()).toBe(resolvedAt.toISOString());

    const successRow = await readLog(nonError);
    expect(successRow.resolution).toBeNull();
    expect(successRow.resolvedAt).toBeNull();

    expect(await countTransactions(userId)).toBe(0);
  });

  it("S10: an unknown flag exits non-zero and writes nothing", async () => {
    const userId = await createUser();
    const logId = await seedLog(userId, { body: PURCHASE_ON_2091 });

    const result = await runDismissCli([`--user-id=${userId}`, "--nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.plan).toBeNull();
    expect(result.report).toBeNull();
    expect((await readLog(logId)).resolution).toBeNull();
  });
});
