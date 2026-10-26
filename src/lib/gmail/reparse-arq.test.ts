import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { planArqReparse, reparseArqReceipts } from "./reparse-arq";

const MARKER = "__reparse_arq_test";

let USER_A = 0;
let USER_B = 0;
let CONN_A = 0;
let CONN_B = 0;
let ARQ_ACCOUNT_A = 0;
let ARQ_ACCOUNT_B = 0;

const COPRcvHtml = () =>
  readFileSync(
    new URL("../gmail/parsers/fixtures/arq-cop-payment-received.html", import.meta.url),
    "utf8",
  );

// An ARQ marketing email: non-transactional, must stay unmatched after a reparse.
const MARKETING_HTML = `<html><head><title>New features are here</title></head>
<body><p>Discover what is new in the ARQ app this month.</p></body></html>`;

async function cleanup() {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${USER_A}, ${USER_B})`);
}

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `${MARKER}-a@test.local`, name: "A" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `${MARKER}-b@test.local`, name: "B" })
    .returning({ id: users.id });
  USER_A = a.id;
  USER_B = b.id;

  const [connA] = await db
    .insert(gmailConnections)
    .values({
      userId: USER_A,
      gmailEmail: `${MARKER}-a@test.local`,
      accessTokenEnc: "dummy",
      refreshTokenEnc: "dummy",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  const [connB] = await db
    .insert(gmailConnections)
    .values({
      userId: USER_B,
      gmailEmail: `${MARKER}-b@test.local`,
      accessTokenEnc: "dummy",
      refreshTokenEnc: "dummy",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  CONN_A = connA.id;
  CONN_B = connB.id;

  const [acctA] = await db
    .insert(accounts)
    .values({
      userId: USER_A,
      name: `${MARKER} ARQ Ahorros A`,
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      metadata: { last4s: ["7073"] },
    })
    .returning({ id: accounts.id });
  const [acctB] = await db
    .insert(accounts)
    .values({
      userId: USER_B,
      name: `${MARKER} ARQ Ahorros B`,
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      metadata: { last4s: ["7073"] },
    })
    .returning({ id: accounts.id });
  ARQ_ACCOUNT_A = acctA.id;
  ARQ_ACCOUNT_B = acctB.id;
});

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${ARQ_ACCOUNT_A}, ${ARQ_ACCOUNT_B})`);
  await db.execute(sql`DELETE FROM gmail_connections WHERE id IN (${CONN_A}, ${CONN_B})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
});

/**
 * Seed a receipt in the state prod left it in: unmatched, with the parser
 * failure persisted by markReceiptNeedsReview.
 */
async function seedUnmatchedReceipt(
  userId: number,
  connId: number,
  msgId: string,
  rawHtml: string,
  reason: string,
): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: msgId,
      gateway: "arq",
      rawHtml,
      emailReceivedAt: new Date("2026-10-25T17:03:00Z"),
      matchStatus: "unmatched",
      parsedAt: new Date("2026-10-25T17:05:00Z"),
      parsedPayload: { error: { reason, kind: "needs_review" } },
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

async function receiptRow(id: number) {
  const [row] = await db
    .select({
      matchStatus: emailReceipts.matchStatus,
      matchedTransactionId: emailReceipts.matchedTransactionId,
      amountCents: emailReceipts.amountCents,
      parsedPayload: emailReceipts.parsedPayload,
    })
    .from(emailReceipts)
    .where(eq(emailReceipts.id, id));
  return row;
}

describe("planArqReparse", () => {
  it("reports which stuck receipts the current parser can now handle, writing nothing", async () => {
    const fixable = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-plan-fixable`,
      COPRcvHtml(),
      "unknown_arq_template",
    );
    const marketing = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-plan-marketing`,
      MARKETING_HTML,
      "unknown_arq_template",
    );

    const plan = await planArqReparse({ userId: USER_A });
    const byId = new Map(plan.candidates.map((c) => [c.receiptId, c]));

    expect(byId.get(fixable)?.outcome).toBe("parsed");
    expect(byId.get(fixable)?.amountUsdcCents).toBe("41250");
    expect(byId.get(fixable)?.counterpartyName).toBe("Test Sender");
    expect(byId.get(marketing)?.outcome).toBe("still_unparsed");
    expect(plan.eligible).toHaveLength(1);

    // Dry run is read-only: both receipts are exactly as seeded.
    for (const id of [fixable, marketing]) {
      const row = await receiptRow(id);
      expect(row.matchStatus).toBe("unmatched");
      expect(row.matchedTransactionId).toBeNull();
    }
    const txRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(0);
  });

  it("only considers the requested user's arq receipts", async () => {
    await seedUnmatchedReceipt(USER_A, CONN_A, `${MARKER}-scope-a`, COPRcvHtml(), "unknown");
    await seedUnmatchedReceipt(USER_B, CONN_B, `${MARKER}-scope-b`, COPRcvHtml(), "unknown");

    const plan = await planArqReparse({ userId: USER_A });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].userId).toBe(USER_A);
  });
});

describe("reparseArqReceipts", () => {
  it("ingests the fixable receipt and leaves the marketing one untouched", async () => {
    const fixable = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-apply-fixable`,
      COPRcvHtml(),
      "unknown_arq_template",
    );
    const marketing = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-apply-marketing`,
      MARKETING_HTML,
      "unknown_arq_template",
    );

    const report = await reparseArqReceipts({ userId: USER_A });

    expect(report.attempted).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.failed).toBe(0);

    const fixableRow = await receiptRow(fixable);
    expect(fixableRow.matchStatus).toBe("matched");
    expect(fixableRow.matchedTransactionId).not.toBeNull();
    expect(fixableRow.amountCents).toBe(BigInt(41250));

    const marketingRow = await receiptRow(marketing);
    expect(marketingRow.matchStatus).toBe("unmatched");
    // Untouched: still carrying the original failure reason, not re-processed.
    const payload = marketingRow.parsedPayload as { error: { reason: string } };
    expect(payload.error.reason).toBe("unknown_arq_template");

    const txRows = await db
      .select({ amountCents: transactions.amountCents, externalId: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(1);
    expect(txRows[0].amountCents).toBe(BigInt(41250));
    expect(txRows[0].externalId).toBe(`arq-email-${fixable}`);
  });

  it("is idempotent — a second run finds nothing to reset and creates no duplicates", async () => {
    await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-apply-twice`,
      COPRcvHtml(),
      "unknown_arq_template",
    );

    const first = await reparseArqReceipts({ userId: USER_A });
    expect(first.attempted).toBe(1);

    const second = await reparseArqReceipts({ userId: USER_A });
    expect(second.attempted).toBe(0);
    expect(second.matched).toBe(0);

    const txRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(1);
  });

  it("reports a receipt that parses but cannot be ingested instead of failing silently", async () => {
    // No ARQ account for this user: the parser succeeds, ingestion cannot route.
    await db.execute(sql`DELETE FROM accounts WHERE id = ${ARQ_ACCOUNT_A}`);
    const receiptId = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-apply-no-account`,
      COPRcvHtml(),
      "unknown_arq_template",
    );

    const report = await reparseArqReceipts({ userId: USER_A });
    expect(report.attempted).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.failures[0]).toMatchObject({ receiptId });

    const row = await receiptRow(receiptId);
    expect(row.matchedTransactionId).toBeNull();
    expect(row.matchStatus).not.toBe("matched");
  });
});

describe("reparseArqReceipts — existing-transaction linking (#1020)", () => {
  // This block owns its ARQ account: another spec deletes the shared one to
  // exercise the "parses but cannot be ingested" path.
  let linkAccountId = 0;

  beforeAll(async () => {
    await db.execute(sql`
      DELETE FROM accounts
      WHERE user_id = ${USER_A} AND currency = 'USD' AND institution_slug = 'other'
    `);
    const [row] = await db
      .insert(accounts)
      .values({
        userId: USER_A,
        name: `${MARKER} ARQ Ahorros link`,
        institution: "ARQ",
        institutionSlug: "other",
        type: "savings",
        currency: "USD",
        metadata: { last4s: ["7073"] },
      })
      .returning({ id: accounts.id });
    linkAccountId = row.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM accounts WHERE id = ${linkAccountId}`);
  });

  /** A live tx the user already had: e.g. logged by hand or read from a Telegram OCR. */
  async function seedExistingTx(opts: {
    occurredAt: Date;
    amountCents: bigint;
    source: "telegram" | "manual";
  }): Promise<number> {
    const [row] = await db
      .insert(transactions)
      .values({
        userId: USER_A,
        accountId: linkAccountId,
        occurredAt: opts.occurredAt,
        amountCents: opts.amountCents,
        currency: "USD",
        descriptionRaw: "ARQ incoming payment (OCR)",
        merchant: "Test Sender",
        source: opts.source,
        channel: "bank",
      })
      .returning({ id: transactions.id });
    return row.id;
  }

  it("links the receipt to the existing tx and inserts nothing", async () => {
    // Same account, same direction, exact amount, same day as the email.
    const existingTxId = await seedExistingTx({
      occurredAt: new Date("2026-10-25T15:00:00Z"),
      amountCents: BigInt(41250),
      source: "telegram",
    });
    const receiptId = await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-link-existing`,
      COPRcvHtml(),
      "unknown_arq_template",
    );

    const report = await reparseArqReceipts({ userId: USER_A });

    expect(report.attempted).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.linked).toBe(1);
    expect(report.failed).toBe(0);

    // Exactly the pre-existing row: the reparse inserted no duplicate.
    const txRows = await db
      .select({ id: transactions.id, externalId: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(1);
    expect(txRows[0].id).toBe(existingTxId);
    expect(txRows[0].externalId).toBeNull();

    // The receipt points at it, so the email is accounted for.
    const row = await receiptRow(receiptId);
    expect(row.matchStatus).toBe("matched");
    expect(row.matchedTransactionId).toBe(existingTxId);
  });

  it("does not link a tx that is outside the ±1 day window", async () => {
    await seedExistingTx({
      occurredAt: new Date("2026-10-23T15:00:00Z"),
      amountCents: BigInt(41250),
      source: "manual",
    });
    await seedUnmatchedReceipt(
      USER_A,
      CONN_A,
      `${MARKER}-link-too-old`,
      COPRcvHtml(),
      "unknown_arq_template",
    );

    const report = await reparseArqReceipts({ userId: USER_A });

    expect(report.matched).toBe(1);
    expect(report.linked).toBe(0);

    // Two rows: the old one, plus the receipt's own new tx.
    const txRows = await db
      .select({ id: transactions.id, externalId: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(2);
    expect(txRows.filter((tx) => tx.externalId !== null)).toHaveLength(1);
  });
});

describe("planArqReparse — filters", () => {
  it("ignores receipts that are already matched", async () => {
    await seedUnmatchedReceipt(USER_A, CONN_A, `${MARKER}-matched`, COPRcvHtml(), "unknown");
    await db
      .update(emailReceipts)
      .set({ matchStatus: "matched" })
      .where(
        inArray(
          emailReceipts.gmailMsgId,
          [`${MARKER}-matched`].map((m) => m),
        ),
      );

    const plan = await planArqReparse({ userId: USER_A });
    expect(plan.candidates).toHaveLength(0);
  });
});
