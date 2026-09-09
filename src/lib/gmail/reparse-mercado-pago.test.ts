import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import {
  countUnmatchedMercadoPagoReceipts,
  reparseUnmatchedMercadoPagoReceipts,
} from "./reparse-mercado-pago";

const TAG = "VITEST_MP_REPARSE_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let connA: number;
let connB: number;

const VOUCHER_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Compraste Almohada Ortopedica</title></head>
<body>
  <p>Compraste Almohada Ortopedica</p>
  <p>Pagaste $98.999</p>
  <p>REDEBAN ES SU RED</p>
  <p>26/01/2026 01:15:34</p>
  <p>****2575 | REF: 56764274023</p>
  <p>AUT: 400227</p>
  <p>COMPRA NETA: $85211</p>
  <p>TOTAL: $85211</p>
</body>
</html>`;

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  const [ua] = await db
    .insert(users)
    .values({ email: `${TAG}a@test.local`, name: `${TAG}a` })
    .returning({ id: users.id });
  userA = ua.id;
  const [ub] = await db
    .insert(users)
    .values({ email: `${TAG}b@test.local`, name: `${TAG}b` })
    .returning({ id: users.id });
  userB = ub.id;

  const [acct] = await db
    .insert(accounts)
    .values({
      userId: userA,
      name: `${TAG}acct`,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  accountA = acct.id;

  const [ca] = await db
    .insert(gmailConnections)
    .values({
      userId: userA,
      gmailEmail: `${TAG}${userA}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  connA = ca.id;
  const [cb] = await db
    .insert(gmailConnections)
    .values({
      userId: userB,
      gmailEmail: `${TAG}${userB}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  connB = cb.id;
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE id IN (${connA}, ${connB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${accountA}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

async function seedReceipt(opts: {
  userId: number;
  connId: number;
  gmailMsgId: string;
  rawHtml: string;
  matchStatus?: "pending" | "matched" | "unmatched";
  parsedAt?: Date | null;
  merchant?: string | null;
  amountCents?: bigint | null;
}): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: opts.gmailMsgId,
      gateway: "mercado_pago",
      rawHtml: opts.rawHtml,
      matchStatus: opts.matchStatus ?? "unmatched",
      parsedAt: opts.parsedAt === undefined ? new Date() : opts.parsedAt,
      merchant: opts.merchant ?? null,
      amountCents: opts.amountCents ?? null,
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

describe("reparseUnmatchedMercadoPagoReceipts", () => {
  it("recovers a silent all-NULL voucher receipt (parsedAt set, no fields)", async () => {
    const id = await seedReceipt({
      userId: userA,
      connId: connA,
      gmailMsgId: `${TAG}silent-null`,
      rawHtml: VOUCHER_HTML,
      matchStatus: "unmatched",
      parsedAt: new Date(),
    });

    const report = await reparseUnmatchedMercadoPagoReceipts({ userId: userA });
    expect(report.reset).toBe(1);

    const [row] = await db
      .select({
        merchant: emailReceipts.merchant,
        amountCents: emailReceipts.amountCents,
        referenceId: emailReceipts.referenceId,
        matchStatus: emailReceipts.matchStatus,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, id));

    expect(row.merchant).toBe("Almohada Ortopedica");
    expect(row.amountCents).toBe(BigInt(8521100));
    expect(row.referenceId).toBe("400227");
    expect(row.matchStatus).toBe("unmatched");
  });

  it("does not reset a matched receipt", async () => {
    const id = await seedReceipt({
      userId: userA,
      connId: connA,
      gmailMsgId: `${TAG}already-matched`,
      rawHtml: VOUCHER_HTML,
      matchStatus: "matched",
      parsedAt: new Date(),
      merchant: "keep-me",
      amountCents: BigInt(1),
    });

    const report = await reparseUnmatchedMercadoPagoReceipts({ userId: userA });
    expect(report.reset).toBe(0);

    const [row] = await db
      .select({ merchant: emailReceipts.merchant, matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, id));
    expect(row.merchant).toBe("keep-me");
    expect(row.matchStatus).toBe("matched");
  });

  it("countUnmatchedMercadoPagoReceipts is tenant-scoped", async () => {
    await seedReceipt({
      userId: userA,
      connId: connA,
      gmailMsgId: `${TAG}a-row`,
      rawHtml: VOUCHER_HTML,
    });
    await seedReceipt({
      userId: userB,
      connId: connB,
      gmailMsgId: `${TAG}b-row`,
      rawHtml: VOUCHER_HTML,
    });

    expect(await countUnmatchedMercadoPagoReceipts({ userId: userA })).toBe(1);
    expect(await countUnmatchedMercadoPagoReceipts({ userId: userB })).toBe(1);
  });
});
