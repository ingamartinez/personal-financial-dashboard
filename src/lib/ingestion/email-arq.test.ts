import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  counterparties,
  counterpartyAliases,
  emailReceipts,
  gmailConnections,
  transactions,
  userAliases,
  users,
} from "@/lib/db/schema";
import { getMonthlyFlow } from "@/lib/dashboard/queries";
import { ingestArqEmail } from "./email-arq";

const MARKER = "__email_arq_test";

let USER_A = 0;
let USER_B = 0;
let CONN_A = 0;
let CONN_B = 0;
let ARQ_ACCOUNT_A = 0;
let ARQ_ACCOUNT_B = 0;
// Second USD account for USER_A — the counterpart leg of a self-transfer.
let OTHER_USD_ACCOUNT_A = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM counterparty_aliases WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM counterparties WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM user_aliases WHERE user_id IN (${USER_A}, ${USER_B})`);
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

  // Gmail connections are required by the emailReceipts FK.
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

  // ARQ Ahorros account for each user (institution_slug='other', USD, last4s=['7073']).
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

  // Plain USD savings account (not ARQ-routable: institution_slug + no ARQ last4)
  // used as the opposite leg of a self-transfer.
  const [otherA] = await db
    .insert(accounts)
    .values({
      userId: USER_A,
      name: `${MARKER} USD Savings A`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "savings",
      currency: "USD",
      metadata: {},
    })
    .returning({ id: accounts.id });
  OTHER_USD_ACCOUNT_A = otherA.id;
});

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM accounts WHERE id IN (${ARQ_ACCOUNT_A}, ${ARQ_ACCOUNT_B}, ${OTHER_USD_ACCOUNT_A})`,
  );
  await db.execute(sql`DELETE FROM gmail_connections WHERE id IN (${CONN_A}, ${CONN_B})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
});

// ---------------------------------------------------------------------------
// HTML fixture builders
// ---------------------------------------------------------------------------

/**
 * Minimal ARQ transfer_received HTML (titled template).
 * Produces: txKind='transfer_received', counterpartyName=name, amountUsdcCents=cents
 */
function buildReceivedHtml(name: string, amountUsd: string): string {
  return `<html>
    <head><title>You received ${amountUsd} USD from ${name}</title></head>
    <body>
      <p>We&apos;ve credited ${amountUsd} USDc to your balance.</p>
    </body>
  </html>`;
}

/**
 * Minimal ARQ transfer_sent HTML (titled template).
 * Produces: txKind='transfer_sent', counterpartyName=name, amountUsdcCents=cents
 */
function buildSentHtml(name: string, amountUsd: string): string {
  return `<html>
    <head><title>You sent ${amountUsd} USD to ${name}</title></head>
    <body>
      <p>We&apos;ve debited ${amountUsd} USDc from your balance.</p>
    </body>
  </html>`;
}

// ---------------------------------------------------------------------------
// Receipt seed helper
// ---------------------------------------------------------------------------

async function seedReceipt(
  userId: number,
  connId: number,
  msgId: string,
  rawHtml: string,
): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: msgId,
      gateway: "arq",
      rawHtml,
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

const NOW = new Date("2026-04-01T10:00:00Z");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestArqEmail — needs_review breaks the retry loop (issue #641)", () => {
  it("marks receipt unmatched with error payload when parser returns needs_review", async () => {
    // Garbage HTML: no title, no recognisable body markers → unknown_arq_template.
    const html = `<html><head></head><body><p>Some unrecognised ARQ email content.</p></body></html>`;
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-nr-1`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);

    // Outcome is still "error" (no transaction) but the receipt is now persisted
    // as unmatched so the cron loop won't pick it up again.
    expect(result.status).toBe("error");

    // Receipt must be updated — match_status='unmatched', parsed_at not null.
    const [row] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        parsedAt: emailReceipts.parsedAt,
        parsedPayload: emailReceipts.parsedPayload,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));

    expect(row.matchStatus).toBe("unmatched");
    expect(row.parsedAt).not.toBeNull();

    // Audit trail: parsed_payload.error.reason populated and kind='needs_review'.
    const payload = row.parsedPayload as { error: { reason: string; kind: string } } | null;
    expect(payload).not.toBeNull();
    expect(payload?.error?.kind).toBe("needs_review");
    expect(payload?.error?.reason).toBe("unknown_arq_template");
  });

  it("no transaction is inserted when parser returns needs_review", async () => {
    const html = `<html><head></head><body><p>Unrecognised content.</p></body></html>`;
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-nr-2`, html);

    await ingestArqEmail(USER_A, receiptId, html, NOW);

    const txRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(0);
  });

  it("idempotency — calling ingestArqEmail twice on needs_review receipt is safe", async () => {
    // After the first call the receipt is unmatched. A second call on the same
    // receipt (simulating manual retry with same HTML) should still just error
    // and update the receipt fields again — no crash, no transaction inserted.
    const html = `<html><head></head><body><p>Unrecognised again.</p></body></html>`;
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-nr-3`, html);

    const r1 = await ingestArqEmail(USER_A, receiptId, html, NOW);
    const r2 = await ingestArqEmail(USER_A, receiptId, html, NOW);

    expect(r1.status).toBe("error");
    expect(r2.status).toBe("error");

    // Still no transaction.
    const txRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(0);
  });
});

describe("ingestArqEmail — counterparty linking", () => {
  it("marks an already-inserted receipt matched on the duplicate path", async () => {
    const html = buildReceivedHtml("Retry Recipient", "2,180");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-duplicate-retry`, html);
    await db.insert(transactions).values({
      userId: USER_A,
      accountId: ARQ_ACCOUNT_A,
      occurredAt: NOW,
      amountCents: BigInt(218000),
      currency: "USD",
      descriptionRaw: "You received 218000 USDc from Retry Recipient",
      merchant: "Retry Recipient",
      source: "gmail_arq",
      channel: "transfer",
      externalId: `arq-email-${receiptId}`,
      rawData: { kind: "transfer_received" },
    });

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);
    const [receipt] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    expect(result.status).toBe("duplicated");
    expect(receipt.matchStatus).toBe("matched");
    expect(receipt.matchedTransactionId).not.toBeNull();
  });

  it("happy path — new ingest links counterparty (and normalizes the alias)", async () => {
    // Mixed case input: proves normalizeName uppercases the alias value
    // even though the parser preserves casing in counterpartyName.
    // (The parser already collapses internal whitespace via /\s+/g, " ").
    const html = buildReceivedHtml("Codebranch Llc", "2,180");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-1`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);

    expect(result.status).toBe("inserted");

    // Transaction must have counterparty_id set.
    const [tx] = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(tx.counterpartyId).not.toBeNull();

    // Display name preserves the original (post-parse) casing.
    const [cp] = await db
      .select({ displayName: counterparties.displayName })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cp.displayName).toBe("Codebranch Llc");

    // Alias VALUE is the uppercased normalized form — proves normalizeName ran.
    const [alias] = await db
      .select({ kind: counterpartyAliases.kind, value: counterpartyAliases.value })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(alias.kind).toBe("name");
    expect(alias.value).toBe("CODEBRANCH LLC");
  });

  it("idempotency — same receipt twice returns duplicated, first call still linked counterparty", async () => {
    const html = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-2`, html);

    const result1 = await ingestArqEmail(USER_A, receiptId, html, NOW);
    expect(result1.status).toBe("inserted");

    // Confirm the FIRST call actually linked the counterparty — without this,
    // the test would still pass even if resolveCounterpartyByKey silently
    // returned null on the first call.
    const [tx] = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(tx.counterpartyId).not.toBeNull();

    const result2 = await ingestArqEmail(USER_A, receiptId, html, NOW);

    expect(result2.status).toBe("duplicated");

    // Still exactly one counterparty and one alias.
    const cpRows = await db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(1);

    const aliasRows = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(aliasRows).toHaveLength(1);
  });

  it("alias matching — different casing maps to the same counterparty", async () => {
    const html1 = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const html2 = buildReceivedHtml("Codebranch Llc", "500");

    const receipt1 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-3a`, html1);
    const receipt2 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-3b`, html2);

    const r1 = await ingestArqEmail(USER_A, receipt1, html1, NOW);
    const r2 = await ingestArqEmail(USER_A, receipt2, html2, NOW);

    expect(r1.status).toBe("inserted");
    expect(r2.status).toBe("inserted");

    // Both transactions share the same counterparty_id.
    const txRows = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(2);
    expect(txRows[0].counterpartyId).not.toBeNull();
    expect(txRows[0].counterpartyId).toBe(txRows[1].counterpartyId);

    // Only one counterparty row and one alias row.
    const cpRows = await db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(1);

    const aliasRows = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(aliasRows).toHaveLength(1);
  });

  it("both directions — transfer_received and transfer_sent create distinct counterparties", async () => {
    const htmlReceived = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const htmlSent = buildSentHtml("GUSTAVO PEREZ", "100");

    const receipt1 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-4a`, htmlReceived);
    const receipt2 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-4b`, htmlSent);

    const r1 = await ingestArqEmail(USER_A, receipt1, htmlReceived, NOW);
    const r2 = await ingestArqEmail(USER_A, receipt2, htmlSent, new Date(NOW.getTime() + 1000));

    expect(r1.status).toBe("inserted");
    expect(r2.status).toBe("inserted");

    // Two distinct counterparties.
    const cpRows = await db
      .select({ displayName: counterparties.displayName })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(2);
    const names = cpRows.map((c) => c.displayName).sort();
    expect(names).toEqual(["CODEBRANCH LLC", "GUSTAVO PEREZ"]);

    // Both transactions have counterparty_id set and they differ.
    const txRows = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(2);
    const ids = txRows.map((t) => t.counterpartyId);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("tenant safety — counterparties are scoped per user", async () => {
    const htmlA = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const htmlB = buildReceivedHtml("CODEBRANCH LLC", "500");

    const receiptA = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-5a`, htmlA);
    const receiptB = await seedReceipt(USER_B, CONN_B, `msg-${MARKER}-5b`, htmlB);

    const rA = await ingestArqEmail(USER_A, receiptA, htmlA, NOW);
    const rB = await ingestArqEmail(USER_B, receiptB, htmlB, NOW);

    expect(rA.status).toBe("inserted");
    expect(rB.status).toBe("inserted");

    // Two distinct counterparty rows — one per user.
    const allCp = await db.execute<{ id: number; user_id: number }>(sql`
        SELECT id, user_id FROM counterparties
        WHERE user_id IN (${USER_A}, ${USER_B})
      `);
    expect(allCp).toHaveLength(2);
    const userIds = allCp.map((c) => c.user_id).sort();
    expect(userIds).toEqual([USER_A, USER_B].sort());

    // Each user's tx points only to their own counterparty.
    const [txA] = await db
      .select({ counterpartyId: transactions.counterpartyId, userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    const [txB] = await db
      .select({ counterpartyId: transactions.counterpartyId, userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.userId, USER_B));

    expect(txA.counterpartyId).not.toBeNull();
    expect(txB.counterpartyId).not.toBeNull();
    expect(txA.counterpartyId).not.toBe(txB.counterpartyId);
  });
});

describe("ingestArqEmail — COP payment received (#1015)", () => {
  // Real redacted template: no <title>, "COP payment received" heading,
  // "$412.50 USDc has been added to your balance" and detail labels.
  const copPaymentReceivedHtml = () =>
    readFileSync(
      new URL("../gmail/parsers/fixtures/arq-cop-payment-received.html", import.meta.url),
      "utf8",
    );

  it("inserts income in USDc and keeps the COP leg out of the pairing signal", async () => {
    const html = copPaymentReceivedHtml();
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-cop-received`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);
    expect(result.status).toBe("inserted");

    const [tx] = await db
      .select({
        amountCents: transactions.amountCents,
        currency: transactions.currency,
        channel: transactions.channel,
        rawData: transactions.rawData,
      })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));

    // Income: positive, USDc cents from "$412.50 USDc".
    expect(tx.amountCents).toBe(BigInt(41250));
    expect(tx.currency).toBe("USD");
    // #1020: an inbound payment from a third party is income, not an internal
    // movement — `transfer` is reserved for the user's own account-to-account legs.
    expect(tx.channel).toBe("bank");

    const rawData = tx.rawData as {
      fx: { trmSource: string; trmToAccountCurrency: number | null; copAmountCents?: string };
      arq: { recipient_name: string; cop_amount_cents?: string; implied_trm_cop_per_usdc?: number };
    };

    // The account leg is USDc 1:1 and must stay that way: writing the sender's
    // COP leg into fx.copAmountCents would make #518's pairer treat this income
    // as one leg of a self-transfer.
    expect(rawData.fx.trmSource).toBe("1_to_1");
    expect(rawData.fx.trmToAccountCurrency).toBe(1);
    expect(rawData.fx.copAmountCents).toBeUndefined();

    // The COP leg is still recorded, under the inert arq namespace.
    expect(rawData.arq.recipient_name).toBe("Test Sender");
    expect(rawData.arq.cop_amount_cents).toBe("125000000");
    expect(rawData.arq.implied_trm_cop_per_usdc).toBeCloseTo(125000000 / 41250, 1);

    // Receipt is matched in one pass, so the cron stops retrying it.
    const [receipt] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
        amountCents: emailReceipts.amountCents,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("matched");
    expect(receipt.matchedTransactionId).not.toBeNull();
    expect(receipt.amountCents).toBe(BigInt(41250));
  });
});

// ---------------------------------------------------------------------------
// #1020 — `transfer` is reserved for movements between the user's own accounts.
// ---------------------------------------------------------------------------
describe("ingestArqEmail — received channel (#1020)", () => {
  const APRIL = {
    start: new Date("2026-04-01T00:00:00Z"),
    end: new Date("2026-05-01T00:00:00Z"),
  };
  const SELF_ALIAS = "Alejandro Rafael Martinez";

  const copPaymentReceivedHtml = () =>
    readFileSync(
      new URL("../gmail/parsers/fixtures/arq-cop-payment-received.html", import.meta.url),
      "utf8",
    );

  it("external payer becomes income: channel=bank and it counts in dashboard income", async () => {
    const html = copPaymentReceivedHtml();
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-1020-external`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);
    expect(result.status).toBe("inserted");

    const [tx] = await db
      .select({
        channel: transactions.channel,
        amountCents: transactions.amountCents,
        transferGroupId: transactions.transferGroupId,
      })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));

    expect(tx.channel).toBe("bank");
    // Nothing to pair against: an inbound third-party payment is not a leg.
    expect(tx.transferGroupId).toBeNull();

    // The point of the fix: the money reaches the income total. 412.50 USDc
    // at 4000 COP/USD = 1,650,000 COP.
    const flow = await getMonthlyFlow(USER_A, 4000, APRIL);
    expect(flow.incomeCopCents).toBe(BigInt(1_650_000_00));
  });

  it("self-transfer keeps channel=transfer, pairs, and stays out of income", async () => {
    // The inbound leg names the user: `user_aliases` is the existing rule the
    // intra-user pairer uses (#518/#1017), reused here at ingest time.
    await db.insert(userAliases).values({ userId: USER_A, alias: SELF_ALIAS });

    const [partner] = await db
      .insert(transactions)
      .values({
        userId: USER_A,
        accountId: OTHER_USD_ACCOUNT_A,
        occurredAt: NOW,
        amountCents: BigInt(-10000),
        currency: "USD",
        descriptionRaw: "Self transfer out",
        source: "manual",
        channel: "transfer",
      })
      .returning({ id: transactions.id });

    const html = buildReceivedHtml(SELF_ALIAS, "100");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-1020-self`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);
    expect(result.status).toBe("inserted");

    const [tx] = await db
      .select({
        channel: transactions.channel,
        transferGroupId: transactions.transferGroupId,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, USER_A), eq(transactions.source, "gmail_arq")));

    expect(tx.channel).toBe("transfer");
    expect(tx.transferGroupId).not.toBeNull();

    // Both legs of one movement share the group, so neither is income or expense.
    const [partnerAfter] = await db
      .select({ transferGroupId: transactions.transferGroupId })
      .from(transactions)
      .where(eq(transactions.id, partner.id));
    expect(partnerAfter.transferGroupId).toBe(tx.transferGroupId);

    const flow = await getMonthlyFlow(USER_A, 4000, APRIL);
    expect(flow.incomeCopCents).toBe(BigInt(0));
    expect(flow.expenseCopCents).toBe(BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// #1020 — an existing transaction is linked, never guessed at.
// ---------------------------------------------------------------------------
describe("ingestArqEmail — duplicate linking (#1020)", () => {
  /** A tx the user already had: logged by hand or read from a Telegram OCR. */
  async function seedExistingTx(opts: {
    merchant: string;
    amountCents: bigint;
    occurredAt: Date;
  }): Promise<number> {
    const [row] = await db
      .insert(transactions)
      .values({
        userId: USER_A,
        accountId: ARQ_ACCOUNT_A,
        occurredAt: opts.occurredAt,
        amountCents: opts.amountCents,
        currency: "USD",
        descriptionRaw: `Pago recibido de ${opts.merchant}`,
        merchant: opts.merchant,
        source: "telegram",
        channel: "bank",
      })
      .returning({ id: transactions.id });
    return row.id;
  }

  async function ingest(msgId: string, html: string, occurredAt: Date = NOW) {
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-${msgId}`, html);
    const result = await ingestArqEmail(USER_A, receiptId, html, occurredAt);
    const [receipt] = await db
      .select({ matchedTransactionId: emailReceipts.matchedTransactionId })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    return { result, matchedTransactionId: receipt.matchedTransactionId };
  }

  it("two same-amount payments from different payers on one day stay two transactions", async () => {
    const first = await ingest("payer-a", buildReceivedHtml("Client Alpha", "500"));
    const second = await ingest("payer-b", buildReceivedHtml("Client Beta", "500"));

    expect(first.result.status).toBe("inserted");
    // Same account, direction, exact amount and day, but a different payer: this
    // is a second payment, not a duplicate. Linking it would delete 500 USD of
    // income from the month.
    expect(second.result.status).toBe("inserted");

    const rows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(rows).toHaveLength(2);
  });

  it("links the receipt to a live tx from the same payer and inserts nothing", async () => {
    const existingTxId = await seedExistingTx({
      merchant: "Client Alpha",
      amountCents: BigInt(50000),
      occurredAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    const { result, matchedTransactionId } = await ingest(
      "same-payer",
      buildReceivedHtml("Client Alpha", "500"),
    );

    expect(result.status).toBe("linked");
    if (result.status === "linked") expect(result.txId).toBe(existingTxId);
    expect(matchedTransactionId).toBe(existingTxId);

    const rows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(rows).toHaveLength(1);
  });

  it("links at exactly ±24h and inserts one second past it", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    await seedExistingTx({
      merchant: "Client Alpha",
      amountCents: BigInt(50000),
      occurredAt: new Date(NOW.getTime() - dayMs),
    });
    const inside = await ingest("edge-inside", buildReceivedHtml("Client Alpha", "500"));
    expect(inside.result.status).toBe("linked");

    await seedExistingTx({
      merchant: "Client Beta",
      amountCents: BigInt(70000),
      occurredAt: new Date(NOW.getTime() - dayMs - 1000),
    });
    const outside = await ingest("edge-outside", buildReceivedHtml("Client Beta", "700"));
    expect(outside.result.status).toBe("inserted");
  });

  it("an outgoing ARQ payment keeps channel=transfer and still inserts", async () => {
    // Out of scope on purpose (#1020): flipping `transfer_sent` to `bank` would
    // retroactively move every historical payout into expense totals.
    const existingTxId = await seedExistingTx({
      merchant: "Contractor Z",
      amountCents: BigInt(-30000),
      occurredAt: NOW,
    });

    const { result } = await ingest("sent", buildSentHtml("Contractor Z", "300"));
    expect(result.status).toBe("inserted");

    const [sent] = await db
      .select({ channel: transactions.channel, transferGroupId: transactions.transferGroupId })
      .from(transactions)
      .where(and(eq(transactions.userId, USER_A), eq(transactions.source, "gmail_arq")));
    expect(sent.channel).toBe("transfer");

    // The pre-existing row is untouched: the sent path never links.
    const [existing] = await db
      .select({ id: transactions.id, amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.id, existingTxId));
    expect(existing.amountCents).toBe(BigInt(-30000));
  });
});
