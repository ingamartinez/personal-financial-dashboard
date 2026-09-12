import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { isStrictOneToOne } from "./csv-cross-source-dedup";
import { findCsvCandidates } from "./backfill-csv-cross-source-dedup";
import { db } from "../src/lib/db";
import {
  accounts,
  reconciliationDecisions,
  statementImports,
  transactions,
  users,
} from "../src/lib/db/schema";
import { collapseCsvCandidate } from "./csv-cross-source-dedup";

const row = { csv_id: 1697, live_id: 899 } as Parameters<typeof isStrictOneToOne>[0];

describe("CSV cross-source backfill candidate guard (#921)", () => {
  it("accepts an exact one-to-one pair", () => {
    expect(isStrictOneToOne(row, new Map([[1697, 1]]), new Map([[899, 1]]))).toBe(true);
  });

  it("rejects the 1:8 false cluster", () => {
    expect(isStrictOneToOne(row, new Map([[1697, 1]]), new Map([[899, 8]]))).toBe(false);
  });

  it("rejects an 8:1 ambiguous CSV cluster", () => {
    expect(isStrictOneToOne(row, new Map([[1697, 8]]), new Map([[899, 1]]))).toBe(false);
  });
});

describe("CSV cross-source collapse", () => {
  const tag = "CSV_BACKFILL_921";
  async function createPair(options: {
    liveImportId?: number | null;
    csvImportId?: number | null;
  }) {
    const [user] = await db
      .insert(users)
      .values({ email: `${tag}-${Date.now()}@test.local`, name: tag })
      .returning({ id: users.id });
    const [account] = await db
      .insert(accounts)
      .values({ userId: user.id, name: tag, institution: tag, type: "savings", currency: "COP" })
      .returning({ id: accounts.id });
    const [live] = await db
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: account.id,
        occurredAt: new Date("2026-04-18T12:00:00Z"),
        amountCents: BigInt(-6200000),
        currency: "COP",
        descriptionRaw: "Gmail",
        merchant: "Gmail merchant",
        source: "gmail_bancolombia",
        channel: "bank",
        statementImportId: options.liveImportId ?? null,
      })
      .returning({ id: transactions.id });
    const [csv] = await db
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: account.id,
        occurredAt: new Date("2026-04-18T12:00:00Z"),
        amountCents: BigInt(-6200000),
        currency: "COP",
        descriptionRaw: "CSV",
        merchant: "CSV merchant",
        source: "csv_reconcile",
        channel: "bank",
        statementImportId: options.csvImportId ?? null,
        rawData: { source: "csv" },
      })
      .returning({ id: transactions.id });
    return { user, account, live, csv };
  }

  it("updates the live survivor, audits the orientation, and soft-deletes CSV", async () => {
    const { user, account, live, csv } = await createPair({});
    try {
      await collapseCsvCandidate(db, {
        csv_id: csv.id,
        live_id: live.id,
        user_id: user.id,
        account_id: account.id,
        live_source: "gmail_bancolombia",
        statement_import_id: null,
      });
      const [survivor] = await db.select().from(transactions).where(eq(transactions.id, live.id));
      const [retired] = await db.select().from(transactions).where(eq(transactions.id, csv.id));
      const [decision] = await db
        .select()
        .from(reconciliationDecisions)
        .where(
          and(
            eq(reconciliationDecisions.userId, user.id),
            eq(reconciliationDecisions.txnId, live.id),
          ),
        );
      expect(survivor.reconciliationStatus).toBe("matched");
      expect(survivor.merchant).toBe("Gmail merchant");
      expect(survivor.rawData).toMatchObject({
        merged_csv_reconcile: { csv_transaction_id: csv.id },
      });
      expect(retired.deletedAt).not.toBeNull();
      expect(decision).toMatchObject({
        txnId: live.id,
        mergedIntoTxnId: csv.id,
        action: "merged_into",
      });
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("collapses a same-import one-to-one pair", async () => {
    const { user, account, live, csv } = await createPair({});
    const [statementImport] = await db
      .insert(statementImports)
      .values({
        userId: user.id,
        accountId: account.id,
        fileHash: `${tag}-same-${Date.now()}`,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
      })
      .returning({ id: statementImports.id });
    try {
      await db
        .update(transactions)
        .set({ statementImportId: statementImport.id })
        .where(and(eq(transactions.id, live.id), eq(transactions.userId, user.id)));
      await db
        .update(transactions)
        .set({ statementImportId: statementImport.id })
        .where(and(eq(transactions.id, csv.id), eq(transactions.userId, user.id)));
      await collapseCsvCandidate(db, {
        csv_id: csv.id,
        live_id: live.id,
        user_id: user.id,
        account_id: account.id,
        live_source: "gmail_bancolombia",
        statement_import_id: statementImport.id,
      });
      const [retired] = await db.select().from(transactions).where(eq(transactions.id, csv.id));
      expect(retired.deletedAt).not.toBeNull();
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("skips a live row matched to a different import", async () => {
    const { user, account, live, csv } = await createPair({});
    const [liveImport] = await db
      .insert(statementImports)
      .values({
        userId: user.id,
        accountId: account.id,
        fileHash: `${tag}-live-${Date.now()}`,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
      })
      .returning({ id: statementImports.id });
    const [candidateImport] = await db
      .insert(statementImports)
      .values({
        userId: user.id,
        accountId: account.id,
        fileHash: `${tag}-candidate-${Date.now()}`,
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
      })
      .returning({ id: statementImports.id });
    try {
      await db
        .update(transactions)
        .set({ statementImportId: liveImport.id })
        .where(and(eq(transactions.id, live.id), eq(transactions.userId, user.id)));
      await collapseCsvCandidate(db, {
        csv_id: csv.id,
        live_id: live.id,
        user_id: user.id,
        account_id: account.id,
        live_source: "gmail_bancolombia",
        statement_import_id: candidateImport.id,
      });
      const [retired] = await db.select().from(transactions).where(eq(transactions.id, csv.id));
      expect(retired.deletedAt).toBeNull();
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});

describe("CSV cross-source backfill discovery", () => {
  const tag = "CSV_BACKFILL_DISCOVERY_968";

  async function importFor(accountId: number, userId: number, suffix: string) {
    const [statementImport] = await db
      .insert(statementImports)
      .values({
        userId,
        accountId,
        fileHash: `${tag}-${suffix}-${Date.now()}`,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
      })
      .returning({ id: statementImports.id });
    return statementImport.id;
  }

  it("finds a strict one-to-one pair when the live import is NULL", async () => {
    const { user, live, csv } = await createPairForDiscovery(tag);
    try {
      const candidates = await findCsvCandidates(db, user.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ csv_id: csv.id, live_id: live.id });
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("finds a strict one-to-one pair when both sides share an import", async () => {
    const { user, account, live, csv } = await createPairForDiscovery(tag);
    const importId = await importFor(account.id, user.id, "same");
    try {
      await db
        .update(transactions)
        .set({ statementImportId: importId })
        .where(and(eq(transactions.id, live.id), eq(transactions.userId, user.id)));
      await db
        .update(transactions)
        .set({ statementImportId: importId })
        .where(and(eq(transactions.id, csv.id), eq(transactions.userId, user.id)));
      const candidates = await findCsvCandidates(db, user.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ csv_id: csv.id, live_id: live.id });
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("excludes a live row matched to a different import", async () => {
    const { user, account, live, csv } = await createPairForDiscovery(tag);
    const liveImportId = await importFor(account.id, user.id, "live");
    const csvImportId = await importFor(account.id, user.id, "candidate");
    try {
      await db
        .update(transactions)
        .set({ statementImportId: liveImportId })
        .where(and(eq(transactions.id, live.id), eq(transactions.userId, user.id)));
      await db
        .update(transactions)
        .set({ statementImportId: csvImportId })
        .where(and(eq(transactions.id, csv.id), eq(transactions.userId, user.id)));
      expect(await findCsvCandidates(db, user.id)).toHaveLength(0);
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});

async function createPairForDiscovery(tag: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `${tag}-${Date.now()}@test.local`, name: tag })
    .returning({ id: users.id });
  const [account] = await db
    .insert(accounts)
    .values({ userId: user.id, name: tag, institution: tag, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  const [live] = await db
    .insert(transactions)
    .values({
      userId: user.id,
      accountId: account.id,
      occurredAt: new Date("2026-04-18T12:00:00Z"),
      amountCents: BigInt(-6200000),
      currency: "COP",
      descriptionRaw: "Gmail",
      merchant: "Gmail merchant",
      source: "gmail_bancolombia",
      channel: "bank",
    })
    .returning({ id: transactions.id });
  const [csv] = await db
    .insert(transactions)
    .values({
      userId: user.id,
      accountId: account.id,
      occurredAt: new Date("2026-04-18T12:00:00Z"),
      amountCents: BigInt(-6200000),
      currency: "COP",
      descriptionRaw: "CSV",
      merchant: "CSV merchant",
      source: "csv_reconcile",
      channel: "bank",
      rawData: { source: "csv" },
    })
    .returning({ id: transactions.id });
  return { user, account, live, csv };
}
