import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import {
  backfillBancolombia,
  backfillBancolombiaDryRun,
  BackfillConnectionError,
} from "./backfill";
import type { AuthedGmailClient } from "./client";
import { GmailConnectionUnusableError, GmailNotConnectedError } from "./client";

const TAG = "GMAIL_BACKFILL_TEST";

let userA: number;
let userB: number;
let connA: number;

const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

async function wipeData(): Promise<void> {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id IN (${userA}, ${userB})`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function seedActiveConnection(userId: number): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function seedCreditCard(userId: number, last4: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} tc ${last4}`,
      institution: "Bancolombia",
      type: "credit_card",
      currency: "COP",
      metadata: { last4s: [last4], creditLimitCents: 10_000_000 },
    })
    .returning({ id: accounts.id });
  return row.id;
}

// Wraps a transactional sentence in the same HTML scaffold the real parser
// tests use — proves the parser's extractVisibleText path works end-to-end.
function wrapBancolombiaEmail(sentence: string): string {
  return `<!DOCTYPE html><html><head><title>Alertas y Notificaciones</title></head><body>
<table><tr><td><h1>&iexcl;Listo! Todo sali&oacute; bien con tus movimientos</h1></td></tr>
<tr><td><p>${sentence}</p></td></tr>
</table></body></html>`;
}

function purchaseSentence(amountCop: string, merchant: string, last4: string, dateDmy: string) {
  return `Bancolombia: Compraste COP${amountCop},00 en ${merchant} con tu T.Cred *${last4}, el ${dateDmy} a las 10:00.`;
}

function fakeMessage(id: string, html: string) {
  const encoded = Buffer.from(html, "utf8").toString("base64url");
  return {
    data: {
      id,
      payload: {
        mimeType: "text/html",
        body: { data: encoded },
      },
    },
  };
}

interface FakeAuthedOpts {
  userId: number;
  connectionId: number;
  // Map of msg_id → HTML body. list() returns every id; get() returns the
  // mapped body. Keeps the fake deterministic and small.
  messages: Record<string, string>;
  // Force list() to paginate via nextPageToken. Used by the pagination test.
  pageSize?: number;
  // When set, throws on the Nth list call. Used to test error handling.
  throwOnListAttempt?: number;
  throwOnListError?: unknown;
}

interface FakeAuthedResult {
  authed: AuthedGmailClient;
  listCalls: { q: string | undefined; pageToken: string | undefined }[];
  getCalls: string[];
}

function fakeAuthed(opts: FakeAuthedOpts): FakeAuthedResult {
  const listCalls: { q: string | undefined; pageToken: string | undefined }[] = [];
  const getCalls: string[] = [];
  const ids = Object.keys(opts.messages);
  let listAttempts = 0;

  const authed = {
    oauth: {} as unknown,
    gmail: {
      users: {
        messages: {
          async list(params: { q?: string; pageToken?: string }) {
            listAttempts++;
            if (opts.throwOnListAttempt === listAttempts && opts.throwOnListError) {
              throw opts.throwOnListError;
            }
            listCalls.push({ q: params.q, pageToken: params.pageToken });
            const pageSize = opts.pageSize ?? ids.length;
            const startIdx = params.pageToken ? Number.parseInt(params.pageToken, 10) : 0;
            const slice = ids.slice(startIdx, startIdx + pageSize);
            const next = startIdx + pageSize < ids.length ? String(startIdx + pageSize) : undefined;
            return {
              data: {
                messages: slice.map((id) => ({ id, threadId: id })),
                nextPageToken: next,
              },
            };
          },
          async get(params: { id: string }) {
            getCalls.push(params.id);
            const body = opts.messages[params.id];
            if (!body) throw new Error(`fake: no body for ${params.id}`);
            return fakeMessage(params.id, body);
          },
        },
      },
    },
    connection: {
      id: opts.connectionId,
      gmailEmail: `${TAG}-${opts.userId}@example.com`,
      accessTokenStale: false,
    },
  } as unknown as AuthedGmailClient;

  return { authed, listCalls, getCalls };
}

describe("gmail/backfill", () => {
  beforeAll(async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    userA = await createUser("A");
    userB = await createUser("B");
  });

  beforeEach(async () => {
    await wipeData();
    await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
    connA = await seedActiveConnection(userA);
  });

  afterEach(async () => {
    await wipeData();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
    await db.delete(users).where(sql`id IN (${userA}, ${userB})`);
    if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
    // Do not close db — see gmail-isolation.test.ts for the shared-pool policy.
  });

  const FROM = new Date("2026-01-01T00:00:00Z");
  const TO = new Date("2027-01-01T00:00:00Z");

  // ---------------------------------------------------------------------------
  // Connection-level errors
  // ---------------------------------------------------------------------------

  it("throws BackfillConnectionError(not_connected) when user has no connection", async () => {
    const getClient = async () => {
      throw new GmailNotConnectedError(userB);
    };
    await expect(
      backfillBancolombiaDryRun(userB, { from: FROM, to: TO }, { getClient }),
    ).rejects.toSatisfy((err) => {
      return err instanceof BackfillConnectionError && err.reason === "not_connected";
    });
  });

  it("throws BackfillConnectionError(revoked) when connection is revoked", async () => {
    const getClient = async () => {
      throw new GmailConnectionUnusableError("revoked", "token revoked");
    };
    await expect(
      backfillBancolombia(userA, { from: FROM, to: TO }, { getClient }),
    ).rejects.toSatisfy((err) => {
      return err instanceof BackfillConnectionError && err.reason === "revoked";
    });
  });

  // ---------------------------------------------------------------------------
  // Dry-run: no writes, accurate counts
  // ---------------------------------------------------------------------------

  it("dry-run does NOT write to DB; reports totals and alreadyStored", async () => {
    await seedCreditCard(userA, "2575");
    const html1 = wrapBancolombiaEmail(
      purchaseSentence("44.247", "MERCHANT_A", "2575", "08/04/2026"),
    );
    const html2 = wrapBancolombiaEmail(
      purchaseSentence("22.100", "MERCHANT_B", "2575", "09/04/2026"),
    );

    // Pre-seed: msg-1 already stored for userA. So dry-run should report
    // alreadyStored=1, newEmails=1.
    await db.insert(emailReceipts).values({
      userId: userA,
      gmailConnectionId: connA,
      gmailMsgId: "msg-1",
      gateway: "bancolombia",
      rawHtml: html1,
    });

    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      messages: { "msg-1": html1, "msg-2": html2 },
    });
    const getClient = async () => authed;

    const receiptsBefore = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    const txsBefore = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userA));

    const report = await backfillBancolombiaDryRun(userA, { from: FROM, to: TO }, { getClient });

    expect(report.totalEmails).toBe(2);
    expect(report.alreadyStored).toBe(1);
    expect(report.newEmails).toBe(1);

    // Nothing written.
    const receiptsAfter = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    const txsAfter = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userA));
    expect(receiptsAfter.length).toBe(receiptsBefore.length);
    expect(txsAfter.length).toBe(txsBefore.length);
  });

  // ---------------------------------------------------------------------------
  // Happy path: lists + fetches + inserts + ingests end-to-end
  // ---------------------------------------------------------------------------

  it("ingests parsed emails into transactions; tenant-scoped to userId", async () => {
    await seedCreditCard(userA, "2575");
    // userB has a different account + connection but NOT receiving this backfill.
    await seedCreditCard(userB, "9999");
    await seedActiveConnection(userB);

    const html1 = wrapBancolombiaEmail(
      purchaseSentence("44.247", "MERCHANT_A", "2575", "08/04/2026"),
    );
    const html2 = wrapBancolombiaEmail(
      purchaseSentence("22.100", "MERCHANT_B", "2575", "09/04/2026"),
    );

    const { authed, getCalls } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      messages: { "msg-1": html1, "msg-2": html2 },
    });
    const getClient = async () => authed;

    const report = await backfillBancolombia(
      userA,
      { from: FROM, to: TO },
      { getClient, sleep: async () => {} },
    );

    expect(report.totalEmails).toBe(2);
    expect(report.alreadyStored).toBe(0);
    expect(report.parsed).toBe(2);
    expect(report.inserted).toBe(2);
    expect(report.matchedExisting).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(report.canceled).toBe(false);
    expect(getCalls.sort()).toEqual(["msg-1", "msg-2"]);

    // Tenant isolation: userB has zero receipts/txs.
    const userBReceipts = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userB));
    const userBTxs = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userB));
    expect(userBReceipts).toHaveLength(0);
    expect(userBTxs).toHaveLength(0);

    // userA receives the 2 receipts + 2 transactions.
    const userAReceipts = await db
      .select({ id: emailReceipts.id, status: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    const userATxs = await db
      .select({ id: transactions.id, source: transactions.source })
      .from(transactions)
      .where(eq(transactions.userId, userA));
    expect(userAReceipts).toHaveLength(2);
    expect(userATxs).toHaveLength(2);
    expect(userATxs.every((t) => t.source === "gmail_bancolombia")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Idempotency: running twice inserts once
  // ---------------------------------------------------------------------------

  it("is idempotent — second run reports inserted=0 and doesn't duplicate txs", async () => {
    await seedCreditCard(userA, "2575");
    const html1 = wrapBancolombiaEmail(
      purchaseSentence("44.247", "MERCHANT_A", "2575", "08/04/2026"),
    );
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      messages: { "msg-1": html1 },
    });
    const getClient = async () => authed;

    const first = await backfillBancolombia(
      userA,
      { from: FROM, to: TO },
      { getClient, sleep: async () => {} },
    );
    expect(first.inserted).toBe(1);

    const second = await backfillBancolombia(
      userA,
      { from: FROM, to: TO },
      { getClient, sleep: async () => {} },
    );
    expect(second.totalEmails).toBe(1);
    expect(second.alreadyStored).toBe(1);
    expect(second.inserted).toBe(0);

    // Still exactly ONE transaction after two runs.
    const txs = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userA));
    expect(txs).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Cancel mid-run
  // ---------------------------------------------------------------------------

  it("stops cleanly when shouldCancel returns true; preserves partial results", async () => {
    await seedCreditCard(userA, "2575");
    const messages: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) {
      messages[`msg-${i}`] = wrapBancolombiaEmail(
        purchaseSentence(
          `10.00${i}`,
          `MERCHANT_${i}`,
          "2575",
          `${String(i).padStart(2, "0")}/04/2026`,
        ),
      );
    }
    const { authed } = fakeAuthed({ userId: userA, connectionId: connA, messages });
    const getClient = async () => authed;

    let seen = 0;
    const shouldCancel = async () => {
      seen++;
      return seen >= 3; // cancel before processing the 3rd msg
    };

    const report = await backfillBancolombia(
      userA,
      { from: FROM, to: TO, shouldCancel },
      { getClient, sleep: async () => {} },
    );

    expect(report.canceled).toBe(true);
    expect(report.inserted).toBe(2); // first two were processed
    const receipts = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    expect(receipts.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // A+ dedup: matching an existing tx counts as matchedExisting, not inserted
  // ---------------------------------------------------------------------------

  it("A+ dedup: existing tx from SMS path counts as matchedExisting, not inserted", async () => {
    const accountId = await seedCreditCard(userA, "2575");

    // Simulate an SMS-ingested tx that matches the email we're about to
    // backfill: same user, same account, same amount, same occurred_at, same
    // kind. Expected outcome: dedup A+ identifies it and marks the receipt
    // matched without inserting a duplicate.
    const occurredAt = new Date("2026-04-08T15:00:00.000Z"); // 10:00 COP
    await db.insert(transactions).values({
      userId: userA,
      accountId,
      occurredAt,
      amountCents: BigInt(-4424700), // SMS purchases store negative amounts
      currency: "COP",
      descriptionRaw: "MERCHANT_A",
      merchant: "MERCHANT_A",
      classificationMethod: "unclassified",
      source: "sms",
      externalId: "bcol-sms:existing-1",
      rawData: { kind: "purchase", sms: "raw sms body" },
    });

    const html = wrapBancolombiaEmail(
      purchaseSentence("44.247", "MERCHANT_A", "2575", "08/04/2026"),
    );
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      messages: { "msg-1": html },
    });
    const getClient = async () => authed;

    const report = await backfillBancolombia(
      userA,
      { from: FROM, to: TO },
      { getClient, sleep: async () => {} },
    );
    expect(report.parsed).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.matchedExisting).toBe(1);

    const txs = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userA));
    expect(txs).toHaveLength(1); // no duplicate

    // Receipt was marked matched to the existing tx.
    const [receipt] = await db
      .select({
        status: emailReceipts.matchStatus,
        matchedTxId: emailReceipts.matchedTransactionId,
      })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.userId, userA), eq(emailReceipts.gmailMsgId, "msg-1")));
    expect(receipt.status).toBe("matched");
    expect(receipt.matchedTxId).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Progress callback
  // ---------------------------------------------------------------------------

  it("fires onProgress at the configured stride and once at 'done'", async () => {
    await seedCreditCard(userA, "2575");
    const messages: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      messages[`msg-${i}`] = wrapBancolombiaEmail(
        purchaseSentence(
          `10.00${i}`,
          `MERCHANT_${i}`,
          "2575",
          `${String(i).padStart(2, "0")}/04/2026`,
        ),
      );
    }
    const { authed } = fakeAuthed({ userId: userA, connectionId: connA, messages });
    const getClient = async () => authed;

    const events: { phase: string; processed: number; total: number }[] = [];
    await backfillBancolombia(
      userA,
      {
        from: FROM,
        to: TO,
        progressStride: 2,
        onProgress: async (p) => {
          events.push(p);
        },
      },
      { getClient, sleep: async () => {} },
    );

    // 'listing' once, 'fetching' at 2/4/5 (stride=2 plus the final count),
    // and 'done' once at the end.
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("listing");
    expect(phases[phases.length - 1]).toBe("done");
    const fetchingEvents = events.filter((e) => e.phase === "fetching");
    expect(fetchingEvents.map((e) => e.processed)).toEqual([2, 4, 5]);
  });

  // ---------------------------------------------------------------------------
  // Pagination: walks all pages via nextPageToken
  // ---------------------------------------------------------------------------

  it("paginates through all list pages (no page cap)", async () => {
    await seedCreditCard(userA, "2575");
    const messages: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) {
      messages[`msg-${i}`] = wrapBancolombiaEmail(
        purchaseSentence(
          `10.00${i}`,
          `MERCHANT_${i}`,
          "2575",
          `${String(i).padStart(2, "0")}/04/2026`,
        ),
      );
    }
    const { authed, listCalls } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      messages,
      pageSize: 2,
    });
    const getClient = async () => authed;

    const report = await backfillBancolombia(
      userA,
      { from: FROM, to: TO },
      { getClient, sleep: async () => {} },
    );
    expect(report.totalEmails).toBe(7);
    // 7 msgs / pageSize=2 → 4 list calls (2+2+2+1).
    expect(listCalls).toHaveLength(4);
  });
});
