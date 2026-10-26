import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { accounts, transactions, userAliases, users } from "../src/lib/db/schema";
import { repairArqReceivedChannel } from "./repair-arq-received-channel";

// #1020 / T3: integration tests for the ARQ received-channel repair script.
//
// The script re-channels historical `gmail_arq` `transfer_received` rows from
// `channel='transfer'` to `channel='bank'`, because `notInternalMovement`
// excludes `transfer` from income. Self-transfers (counterparty is the user)
// must keep `transfer`, and a second apply must be a no-op.
//
// Order independence: this file owns its user, account and alias rows and
// deletes them in afterAll, so it never depends on another spec's fixtures.

const MARKER = "repair_arq_received_channel_test";
const USER_EMAIL = `${MARKER}@test.local`;
const USER_NAME = "Repair Fixture Owner";
// A `user_aliases` value for the fixture user. A receipt whose counterparty is
// this name is the credit leg of a self-transfer.
const USER_ALIAS = "Fixture Alias Holder";

const THIRD_PARTY_MERCHANT = "CODEBRANCH LLC";
const OTHER_THIRD_PARTY_MERCHANT = "ACME SAAS";

let userId = 0;
let accountId = 0;

function usersWithMarker() {
  return sql`SELECT id FROM users WHERE email = ${USER_EMAIL}`;
}

async function cleanupTransactions(): Promise<void> {
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${usersWithMarker()})`);
}

async function cleanupAll(): Promise<void> {
  await cleanupTransactions();
  await db.execute(sql`DELETE FROM user_aliases WHERE user_id IN (${usersWithMarker()})`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id IN (${usersWithMarker()})`);
  await db.execute(sql`DELETE FROM users WHERE email = ${USER_EMAIL}`);
}

beforeAll(async () => {
  await cleanupAll();

  const [user] = await db
    .insert(users)
    .values({ email: USER_EMAIL, name: USER_NAME })
    .returning({ id: users.id });
  userId = user.id;

  await db.insert(userAliases).values({ userId, alias: USER_ALIAS });

  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${MARKER} ARQ Ahorros`,
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      metadata: { last4s: ["7073"] },
    })
    .returning({ id: accounts.id });
  accountId = account.id;
});

beforeEach(cleanupTransactions);

afterAll(cleanupAll);

/** Seed one `gmail_arq` `transfer_received` row shaped like the ingest path. */
async function seedArqReceived(opts: {
  suffix: string;
  merchant: string | null;
  amountCents: bigint;
  channel: "transfer" | "bank";
  recipientName?: string | null;
  transferGroupId?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-10-26T15:00:00.000Z"),
      amountCents: opts.amountCents,
      currency: "USD",
      descriptionRaw: `You received ${opts.amountCents} USDc from ${opts.merchant ?? "someone"}`,
      merchant: opts.merchant,
      source: "gmail_arq",
      channel: opts.channel,
      externalId: `${MARKER}-${opts.suffix}`,
      transferGroupId: opts.transferGroupId ?? null,
      rawData: {
        kind: "transfer_received",
        arq: { recipient_name: opts.recipientName ?? opts.merchant },
      },
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedFixture(): Promise<{
  thirdPartyId: number;
  selfTransferId: number;
  alreadyBankId: number;
}> {
  const thirdPartyId = await seedArqReceived({
    suffix: "third-party",
    merchant: THIRD_PARTY_MERCHANT,
    amountCents: BigInt(1_200_000),
    channel: "transfer",
  });
  // Counterparty equals a user_aliases row of this user → self-transfer.
  const selfTransferId = await seedArqReceived({
    suffix: "self",
    merchant: USER_ALIAS,
    amountCents: BigInt(500_000),
    channel: "transfer",
  });
  // Already fixed by re-ingestion: not a candidate.
  const alreadyBankId = await seedArqReceived({
    suffix: "already-bank",
    merchant: OTHER_THIRD_PARTY_MERCHANT,
    amountCents: BigInt(90_000),
    channel: "bank",
  });
  return { thirdPartyId, selfTransferId, alreadyBankId };
}

async function channelsById(ids: number[]): Promise<Record<number, string>> {
  const rows = await db
    .select({ id: transactions.id, channel: transactions.channel })
    .from(transactions)
    .where(inArray(transactions.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.channel]));
}

async function rawDataKindById(id: number): Promise<unknown> {
  const [row] = await db
    .select({ kind: sql<string | null>`${transactions.rawData} ->> 'kind'` })
    .from(transactions)
    .where(inArray(transactions.id, [id]));
  return row.kind;
}

describe("repairArqReceivedChannel (#1020 T3)", () => {
  it("lists the third-party receipt and nothing else on a dry run, writing nothing", async () => {
    const { thirdPartyId, selfTransferId, alreadyBankId } = await seedFixture();

    const plan = await repairArqReceivedChannel({ dryRun: true, userId });

    expect(plan.changed).toBe(0);
    expect(plan.rows.map((row) => row.txId)).toEqual([thirdPartyId]);
    expect(plan.rows[0]).toMatchObject({
      txId: thirdPartyId,
      userId,
      merchant: THIRD_PARTY_MERCHANT,
      amountCents: "1200000",
    });
    expect(plan.rows[0].occurredAt.toISOString()).toBe("2026-10-26T15:00:00.000Z");

    // Dry run writes nothing: the candidate is still `transfer`.
    await expect(channelsById([thirdPartyId, selfTransferId, alreadyBankId])).resolves.toEqual({
      [thirdPartyId]: "transfer",
      [selfTransferId]: "transfer",
      [alreadyBankId]: "bank",
    });
  });

  it("flips exactly the third-party receipt to bank and a second apply is a no-op", async () => {
    const { thirdPartyId, selfTransferId, alreadyBankId } = await seedFixture();

    const applied = await repairArqReceivedChannel({ dryRun: false, userId });

    expect(applied.rows.map((row) => row.txId)).toEqual([thirdPartyId]);
    expect(applied.changed).toBe(1);
    await expect(channelsById([thirdPartyId, selfTransferId, alreadyBankId])).resolves.toEqual({
      [thirdPartyId]: "bank",
      [selfTransferId]: "transfer",
      [alreadyBankId]: "bank",
    });

    // Nothing but `channel`/`updated_at` was touched.
    await expect(rawDataKindById(thirdPartyId)).resolves.toBe("transfer_received");

    const secondRun = await repairArqReceivedChannel({ dryRun: false, userId });
    expect(secondRun.rows).toEqual([]);
    expect(secondRun.changed).toBe(0);

    await expect(channelsById([thirdPartyId, selfTransferId])).resolves.toEqual({
      [thirdPartyId]: "bank",
      [selfTransferId]: "transfer",
    });
  });

  it("leaves self-identifying and already-grouped rows alone", async () => {
    // A legacy row with no `merchant`: the identity check must still find the
    // user in `raw_data.arq.recipient_name`, the field the pairer reads.
    const legacySelfId = await seedArqReceived({
      suffix: "legacy-self",
      merchant: null,
      recipientName: USER_ALIAS,
      amountCents: BigInt(700_000),
      channel: "transfer",
    });
    // A grouped leg is an internal movement whatever its counterparty string
    // says; splitting it off its group would make it count as income.
    const groupedId = await seedArqReceived({
      suffix: "grouped",
      merchant: THIRD_PARTY_MERCHANT,
      amountCents: BigInt(800_000),
      channel: "transfer",
      transferGroupId: "00000000-0000-4000-8000-000000000102",
    });

    const plan = await repairArqReceivedChannel({ dryRun: true, userId });
    expect(plan.rows).toEqual([]);

    const applied = await repairArqReceivedChannel({ dryRun: false, userId });
    expect(applied.changed).toBe(0);
    await expect(channelsById([legacySelfId, groupedId])).resolves.toEqual({
      [legacySelfId]: "transfer",
      [groupedId]: "transfer",
    });
  });
});
