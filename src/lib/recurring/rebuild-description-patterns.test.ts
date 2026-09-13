import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import {
  computePatternsFromSources,
  rebuildDescriptionPatterns,
} from "./rebuild-description-patterns";

const TAG = "test-rebuild-patterns-852";

async function seedUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: suffix })
    .returning({ id: users.id });
  return row.id;
}

async function seedAccount(userId: number, suffix = ""): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-acct${suffix}`,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedRecurring(
  userId: number,
  accountId: number,
  opts: { label: string; amountCents: bigint; dayOfMonth: number },
): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label: opts.label,
      amountCents: opts.amountCents,
      currency: "COP",
      dayOfMonth: opts.dayOfMonth,
      active: true,
    })
    .returning({ id: recurringTransactions.id });
  return row.id;
}

async function seedTx(
  userId: number,
  accountId: number,
  opts: {
    occurredOn: string;
    amountCents: bigint;
    description: string;
    recurringId?: number;
    recurringYearMonth?: string;
  },
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00-05:00`),
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.description,
      classificationMethod: "unclassified",
      source: "manual",
      recurringId: opts.recurringId ?? null,
      recurringYearMonth: opts.recurringYearMonth ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedObservation(opts: {
  userId: number;
  recurringId: number;
  txId: number;
  yearMonth: string;
  description: string;
  accountId: number;
  amountCents: bigint;
}): Promise<void> {
  await db.insert(recurringLinkObservations).values({
    userId: opts.userId,
    recurringId: opts.recurringId,
    txId: opts.txId,
    yearMonth: opts.yearMonth,
    realAmountCents: opts.amountCents,
    realCurrency: "COP",
    descriptionRaw: opts.description,
    accountId: opts.accountId,
    manual: true,
  });
}

async function seedStalePattern(opts: {
  userId: number;
  recurringId: number;
  pattern: string;
  observationCount: number;
}): Promise<void> {
  await db.insert(recurringDescriptionPatterns).values({
    userId: opts.userId,
    recurringId: opts.recurringId,
    pattern: opts.pattern,
    observationCount: opts.observationCount,
  });
}

async function patternsFor(userId: number, recurringId: number) {
  return db
    .select({
      pattern: recurringDescriptionPatterns.pattern,
      observationCount: recurringDescriptionPatterns.observationCount,
    })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        eq(recurringDescriptionPatterns.recurringId, recurringId),
      ),
    );
}

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_link_observations WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM recurring_description_patterns WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM recurring_gaps WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM recurring_transactions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
}

describe("computePatternsFromSources", () => {
  it("counts distinct txs, not stacked old observationCounts", () => {
    const rows = computePatternsFromSources([
      {
        userId: 1,
        recurringId: 13,
        txId: 1,
        descriptionRaw: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
        at: new Date("2026-05-15T00:00:00Z"),
      },
      {
        userId: 1,
        recurringId: 13,
        txId: 2,
        descriptionRaw: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
        at: new Date("2026-06-24T00:00:00Z"),
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        userId: 1,
        recurringId: 13,
        pattern: "EMPRESAS",
        observationCount: 2,
      }),
    ]);
  });

  it("does not double-count the same tx from observation + linked-tx sources", () => {
    const at = new Date("2026-05-15T00:00:00Z");
    const rows = computePatternsFromSources([
      {
        userId: 1,
        recurringId: 13,
        txId: 1,
        descriptionRaw: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
        at,
      },
      {
        userId: 1,
        recurringId: 13,
        txId: 1,
        descriptionRaw: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
        at,
      },
    ]);
    expect(rows[0]?.observationCount).toBe(1);
  });

  it("collapses Pago-prefix and merchant-only descriptions into one EMPRESAS count", () => {
    // Old tokenizer split these into PAGO vs EMPRESAS (two untrusted rows).
    // Merging them is two real observations of the same merchant, not invented.
    const rows = computePatternsFromSources([
      {
        userId: 1,
        recurringId: 13,
        txId: 1,
        descriptionRaw: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
        at: new Date("2026-05-15T00:00:00Z"),
      },
      {
        userId: 1,
        recurringId: 13,
        txId: 2,
        descriptionRaw: "EMPRESAS PUBLICAS DE MEDELLIN",
        at: new Date("2026-06-24T00:00:00Z"),
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pattern: "EMPRESAS", observationCount: 2 });
  });

  it("does not invent a token when the description is only a payment verb", () => {
    expect(
      computePatternsFromSources([
        {
          userId: 1,
          recurringId: 13,
          txId: 1,
          descriptionRaw: "Pago",
          at: new Date("2026-05-15T00:00:00Z"),
        },
      ]),
    ).toEqual([]);
  });
});

describe("rebuildDescriptionPatterns", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("does not invent EMPRESAS from a stale PAGO row with no descriptions", async () => {
    const userId = await seedUser("no-src");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-orphan-pago`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 9 });

    const report = await rebuildDescriptionPatterns({ userId, relink: false });
    expect(report.changed).toBe(true);
    expect(await patternsFor(userId, recId)).toEqual([]);
  });

  it("rewrites PAGO → EMPRESAS from observations and is idempotent", async () => {
    const userId = await seedUser("epm");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-epm`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    const txMay = await seedTx(userId, accountId, {
      occurredOn: "2026-05-15",
      amountCents: BigInt(-51866000),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-05",
    });
    const txJun = await seedTx(userId, accountId, {
      occurredOn: "2026-06-24",
      amountCents: BigInt(-66777500),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-06",
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txMay,
      yearMonth: "2026-05",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-51866000),
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txJun,
      yearMonth: "2026-06",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-66777500),
    });
    // Stale count MUST disagree with source cardinality. Copying 9 onto
    // EMPRESAS derived from 2 txs would invent a trusted pattern.
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 9 });

    const first = await rebuildDescriptionPatterns({ userId, relink: false });
    expect(first.changed).toBe(true);
    expect(await patternsFor(userId, recId)).toEqual([
      { pattern: "EMPRESAS", observationCount: 2 },
    ]);

    // Leave an orphan so the second run must still attempt relink even
    // though patterns are unchanged. If unchanged skips relink, this is 0
    // and a crash mid-auto-link would never retry tx 2652.
    const orphan = await seedTx(userId, accountId, {
      occurredOn: "2026-09-09",
      amountCents: BigInt(-59459400),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
    });
    const second = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(second.changed).toBe(false);
    expect(second.relinkAttempted).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 0));
    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, orphan));
    expect(linked.recurringId).toBe(recId);
  });

  it("#864: relink of an already-sourced tx does not inflate count; second run is unchanged", async () => {
    // Undo-match leaves the observation row. Relink re-links that tx and
    // recordRecurringLinkObservation increments observation_count even though
    // the observation already existed — extra relative to distinct tx ids.
    // The first run must actually relink; the second must report changed:false
    // with the derived count. If the post-relink re-derive is removed, the
    // increment survives and this test goes red.
    const userId = await seedUser("864-idempotent");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-864`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    const txMay = await seedTx(userId, accountId, {
      occurredOn: "2026-05-15",
      amountCents: BigInt(-51866000),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-05",
    });
    const txJun = await seedTx(userId, accountId, {
      occurredOn: "2026-06-24",
      amountCents: BigInt(-66777500),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-06",
    });
    const orphan = await seedTx(userId, accountId, {
      occurredOn: "2026-09-09",
      amountCents: BigInt(-59459400),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txMay,
      yearMonth: "2026-05",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-51866000),
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txJun,
      yearMonth: "2026-06",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-66777500),
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: orphan,
      yearMonth: "2026-09",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-59459400),
    });
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 9 });

    const first = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(first.changed).toBe(true);
    expect(first.relinked).toBe(1);
    expect(await patternsFor(userId, recId)).toEqual([
      { pattern: "EMPRESAS", observationCount: 3 },
    ]);
    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, orphan));
    expect(linked.recurringId).toBe(recId);

    const second = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(second.changed).toBe(false);
    expect(await patternsFor(userId, recId)).toEqual([
      { pattern: "EMPRESAS", observationCount: 3 },
    ]);
  });

  it("dry-run does not write", async () => {
    const userId = await seedUser("dry");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-dry`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 2 });

    const report = await rebuildDescriptionPatterns({ userId, dryRun: true, relink: true });
    expect(report.dryRun).toBe(true);
    expect(report.changed).toBe(true);
    expect(await patternsFor(userId, recId)).toEqual([{ pattern: "PAGO", observationCount: 2 }]);
  });

  it("tx 2652 shape: after rebuild, unique EMPRESAS relinks the unlinked bill", async () => {
    const userId = await seedUser("2652");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-factura-epm`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    const txMay = await seedTx(userId, accountId, {
      occurredOn: "2026-05-15",
      amountCents: BigInt(-51866000),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-05",
    });
    const txJun = await seedTx(userId, accountId, {
      occurredOn: "2026-06-24",
      amountCents: BigInt(-66777500),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-06",
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txMay,
      yearMonth: "2026-05",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-51866000),
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: txJun,
      yearMonth: "2026-06",
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      accountId,
      amountCents: BigInt(-66777500),
    });
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 2 });
    const tx2652 = await seedTx(userId, accountId, {
      occurredOn: "2026-09-09",
      amountCents: BigInt(-59459400),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
    });

    const report = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(report.relinked).toBe(1);
    await new Promise((r) => setTimeout(r, 0));

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx2652));
    expect(row.recurringId).toBe(recId);
  });

  it("APORTES twins still share the stripped token — overlap does not relink", async () => {
    const userId = await seedUser("aportes");
    const accountId = await seedAccount(userId);
    const aida = await seedRecurring(userId, accountId, {
      label: `${TAG}-aida`,
      amountCents: BigInt(-49910000),
      dayOfMonth: 1,
    });
    const alejo = await seedRecurring(userId, accountId, {
      label: `${TAG}-alejo`,
      amountCents: BigInt(-50830000),
      dayOfMonth: 1,
    });
    for (const recId of [aida, alejo]) {
      const txId = await seedTx(userId, accountId, {
        occurredOn: "2026-05-04",
        amountCents: recId === aida ? BigInt(-49910000) : BigInt(-50830000),
        description: "Pago a APORTES EN LINEA",
        recurringId: recId,
        recurringYearMonth: "2026-05",
      });
      const txId2 = await seedTx(userId, accountId, {
        occurredOn: "2026-06-11",
        amountCents: recId === aida ? BigInt(-49910000) : BigInt(-50830000),
        description: "Pago a APORTES EN LINEA",
        recurringId: recId,
        recurringYearMonth: "2026-06",
      });
      await seedObservation({
        userId,
        recurringId: recId,
        txId,
        yearMonth: "2026-05",
        description: "Pago a APORTES EN LINEA",
        accountId,
        amountCents: recId === aida ? BigInt(-49910000) : BigInt(-50830000),
      });
      await seedObservation({
        userId,
        recurringId: recId,
        txId: txId2,
        yearMonth: "2026-06",
        description: "Pago a APORTES EN LINEA",
        accountId,
        amountCents: recId === aida ? BigInt(-49910000) : BigInt(-50830000),
      });
      await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 2 });
    }
    const overlap = await seedTx(userId, accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-50350000),
      description: "Pago a APORTES EN LINEA",
    });

    const report = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(await patternsFor(userId, aida)).toEqual([{ pattern: "APORTES", observationCount: 2 }]);
    expect(await patternsFor(userId, alejo)).toEqual([{ pattern: "APORTES", observationCount: 2 }]);
    expect(report.relinked).toBe(0);

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, overlap));
    expect(row.recurringId).toBeNull();
  });

  it("does not relink generic transfer boilerplate as confidence grows mid-run", async () => {
    const userId = await seedUser("982-transferencia");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-transferencia`,
      amountCents: BigInt(-230000000),
      dayOfMonth: 1,
    });
    const correct = await seedTx(userId, accountId, {
      occurredOn: "2026-08-08",
      amountCents: BigInt(-230000000),
      description: "Transferencia a cuenta *78864674631",
      recurringId: recId,
      recurringYearMonth: "2026-08",
    });
    await seedObservation({
      userId,
      recurringId: recId,
      txId: correct,
      yearMonth: "2026-08",
      description: "Transferencia a cuenta *78864674631",
      accountId,
      amountCents: BigInt(-230000000),
    });
    const wrong = await seedTx(userId, accountId, {
      occurredOn: "2026-09-08",
      amountCents: BigInt(-800000),
      description: "Transferencia recibida de ALEJANDRO MARTINEZ",
    });
    const report = await rebuildDescriptionPatterns({ userId, relink: true });
    expect(report.relinked).toBe(0);
    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, wrong));
    expect(row.recurringId).toBeNull();
    expect(await patternsFor(userId, recId)).toEqual([]);
    expect((await rebuildDescriptionPatterns({ userId, relink: true })).changed).toBe(false);
  });

  it("picks up a currently-linked tx that has no observation row", async () => {
    const userId = await seedUser("linked-only");
    const accountId = await seedAccount(userId);
    const recId = await seedRecurring(userId, accountId, {
      label: `${TAG}-linked-only`,
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    await seedTx(userId, accountId, {
      occurredOn: "2026-05-15",
      amountCents: BigInt(-51866000),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
      recurringId: recId,
      recurringYearMonth: "2026-05",
    });
    await seedStalePattern({ userId, recurringId: recId, pattern: "PAGO", observationCount: 1 });

    await rebuildDescriptionPatterns({ userId, relink: false });
    expect(await patternsFor(userId, recId)).toEqual([
      { pattern: "EMPRESAS", observationCount: 1 },
    ]);
  });
});
