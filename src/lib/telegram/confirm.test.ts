import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { arqStatementImports, transactions, users, accounts } from "@/lib/db/schema";
import { insertFromDraft } from "./confirm";

const TAG = "TG_CONFIRM_921";

describe("Telegram confirmation statement reconciliation (#921)", () => {
  let userId: number;
  let accountId: number;
  let statementId: number;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${TAG}-${Date.now()}@test.local`, name: TAG })
      .returning({ id: users.id });
    userId = user.id;
    const [account] = await db
      .insert(accounts)
      .values({ userId, name: TAG, institution: TAG, type: "savings", currency: "USD" })
      .returning({ id: accounts.id });
    accountId = account.id;
    const [importRow] = await db
      .insert(arqStatementImports)
      .values({
        userId,
        accountId,
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
        declaredStartCents: BigInt(0),
        declaredEndCents: BigInt(0),
        parsedCount: 0,
        parsedSumCents: BigInt(0),
        reconciled: true,
        rawPdfHash: `${TAG}-hash`,
      })
      .returning({ id: arqStatementImports.id });
    statementId = (
      await db
        .insert(transactions)
        .values({
          userId,
          accountId,
          occurredAt: new Date("2026-05-11T17:00:00Z"),
          amountCents: BigInt(-3500000),
          currency: "USD",
          descriptionRaw: "Statement merchant",
          merchant: "Statement merchant",
          source: "arq_statement",
          channel: "transfer",
          arqStatementImportId: importRow.id,
          externalId: `${TAG}-statement`,
        })
        .returning({ id: transactions.id })
    )[0].id;
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await db.$client.end();
  });

  it("retires a Telegram row into the existing statement after confirmation", async () => {
    const result = await insertFromDraft({
      userId,
      chatId: 921,
      sourceMessageId: 921001,
      draft: {
        amountCents: "3500000",
        currency: "USD",
        direction: "expense",
        accountId,
        merchant: "Statement merchant",
        occurredOn: "2026-05-11",
      },
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;
    const [statement] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, statementId));
    const [telegram] = await db.select().from(transactions).where(eq(transactions.id, result.txId));
    expect(statement.secondarySource).toBe("telegram");
    expect((statement.rawData as Record<string, unknown>).merged_telegram).toMatchObject({
      telegram_transaction_id: result.txId,
    });
    expect(telegram.deletedAt).not.toBeNull();
  });
});
