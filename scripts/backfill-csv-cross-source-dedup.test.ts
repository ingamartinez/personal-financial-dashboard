import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { isStrictOneToOne } from "./csv-cross-source-dedup";
import { db } from "../src/lib/db";
import { accounts, reconciliationDecisions, transactions, users } from "../src/lib/db/schema";
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
  it("updates the live survivor, audits the orientation, and soft-deletes CSV", async () => {
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
        statementImportId: null,
        rawData: { source: "csv" },
      })
      .returning({ id: transactions.id });
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
});
