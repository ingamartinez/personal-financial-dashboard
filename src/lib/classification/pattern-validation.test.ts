import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, ruleProposals, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import {
  InvalidSynthesizedPatternError,
  SYNTHESIS_PATTERN_MIN_LITERALS,
  assertIlikePatternShape,
  ilikeLiteralLength,
  insertSynthesizedRuleProposal,
  loadPatternBlastRadius,
  validateSynthesizedPattern,
  type InsertSynthesizedRuleProposalInput,
  type ValidatedIlikePattern,
} from "./pattern-validation";

const TAG = "SYN_PAT_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} account`,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

let seq = 0;
async function insertTx(args: {
  userId: number;
  accountId: number;
  descriptionRaw: string;
  merchant?: string | null;
}): Promise<number> {
  seq++;
  const [row] = await db
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt: new Date("2026-03-26T15:00:00Z"),
      amountCents: BigInt(-5000),
      currency: "COP",
      descriptionRaw: args.descriptionRaw,
      merchant: args.merchant ?? null,
      categorySlug: "otros",
      classificationMethod: "unclassified",
      source: "sms",
      externalId: `${TAG}-${seq}`,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

afterEach(cleanup);

describe("pattern shape guard", () => {
  it("pins a minimum literal length that rejects % and %A%", () => {
    expect(SYNTHESIS_PATTERN_MIN_LITERALS).toBe(3);
    expect(ilikeLiteralLength("%")).toBe(0);
    expect(ilikeLiteralLength("%A%")).toBe(1);
    expect(ilikeLiteralLength("%UBER%")).toBe(4);
    expect(() => assertIlikePatternShape("%")).toThrow(InvalidSynthesizedPatternError);
    expect(() => assertIlikePatternShape("%A%")).toThrow(InvalidSynthesizedPatternError);
    expect(() => assertIlikePatternShape("%UBER%")).not.toThrow();
  });

  it("rejects an opaque gateway stem so the bank string cannot become a rule", () => {
    expect(() => assertIlikePatternShape("%MERCADOPAGO%")).toThrow(/opaque/);
    expect(() => assertIlikePatternShape("%WOMPI%")).toThrow(/opaque/);
  });
});

describe("type doors", () => {
  it("InsertSynthesizedRuleProposalInput.pattern does not accept a raw string", () => {
    type AcceptsString = string extends InsertSynthesizedRuleProposalInput["pattern"]
      ? true
      : false;
    const acceptsString: AcceptsString = false;
    expect(acceptsString).toBe(false);
  });

  it("cannot grow an autoApply field onto the insert input", () => {
    type Allowed = "userId" | "categorySlug" | "pattern" | "coveredMerchants" | "correctionTxnIds";
    type Extra = Exclude<keyof InsertSynthesizedRuleProposalInput, Allowed>;
    const extra: Extra extends never ? true : Extra = true;
    expect(extra).toBe(true);
  });

  it("insert input has no merchant field so this path cannot key on a covered exact merchant", () => {
    type HasMerchant = "merchant" extends keyof InsertSynthesizedRuleProposalInput ? true : false;
    const hasMerchant: HasMerchant = false;
    expect(hasMerchant).toBe(false);
  });
});

describe("validateSynthesizedPattern + insert", () => {
  it("rejects a pattern that matches an implausible share of history", async () => {
    const userId = await createUser(`${TAG}-share@test.local`);
    const accountId = await createAccount(userId);
    for (let i = 0; i < 20; i++) {
      await insertTx({
        userId,
        accountId,
        descriptionRaw: `FILLER ${i}`,
        merchant: `FILLER ${i}`,
      });
    }
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX TRIP",
      merchant: "SYNUBERX TRIP",
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX EATS",
      merchant: "SYNUBERX EATS",
    });

    await expect(
      validateSynthesizedPattern({
        userId,
        pattern: "%FILLER%",
        categorySlug: "uber-didi",
        coveredMerchants: ["FILLER 0", "FILLER 1"],
      }),
    ).rejects.toMatchObject({ code: "match_share" });
  });

  it("rejects a pattern that does not cover the merchants it claims", async () => {
    const userId = await createUser(`${TAG}-cover@test.local`);
    await createAccount(userId);

    await expect(
      validateSynthesizedPattern({
        userId,
        pattern: "%SYNUBERX%",
        categorySlug: "uber-didi",
        coveredMerchants: ["SYNUBERX TRIP", "RAPPI PRIME"],
      }),
    ).rejects.toMatchObject({ code: "uncovered_merchant" });
  });

  it("rejects an unknown category slug instead of creating one", async () => {
    const userId = await createUser(`${TAG}-slug@test.local`);
    await expect(
      validateSynthesizedPattern({
        userId,
        pattern: "%SYNUBERX%",
        categorySlug: "muebles-inventados",
        coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
      }),
    ).rejects.toMatchObject({ code: "category" });
  });

  it("computes blast radius count and sample before approval", async () => {
    const userId = await createUser(`${TAG}-blast@test.local`);
    const accountId = await createAccount(userId);
    for (let i = 0; i < 20; i++) {
      await insertTx({ userId, accountId, descriptionRaw: `OTHER ${i}`, merchant: `OTHER ${i}` });
    }
    const id1 = await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX TRIP",
      merchant: "SYNUBERX TRIP",
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX EATS",
      merchant: "SYNUBERX EATS",
    });

    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SMS SYNUBERX CHARGE",
      merchant: "BANCOLOMBIA",
    });

    const blast = await loadPatternBlastRadius(userId, "%SYNUBERX%");
    expect(blast.matchCount).toBe(3);
    expect(blast.totalCount).toBe(23);
    expect(blast.sample.map((s) => s.merchant)).toEqual(
      expect.arrayContaining(["SYNUBERX TRIP", "SYNUBERX EATS", "BANCOLOMBIA"]),
    );
    expect(blast.sample.some((s) => s.id === id1)).toBe(true);
  });

  it("inserts a pending synthesized proposal and never writes classification_rules", async () => {
    const userId = await createUser(`${TAG}-insert@test.local`);
    const accountId = await createAccount(userId);
    for (let i = 0; i < 20; i++) {
      await insertTx({ userId, accountId, descriptionRaw: `OTHER ${i}`, merchant: `OTHER ${i}` });
    }
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX TRIP",
      merchant: "SYNUBERX TRIP",
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX EATS",
      merchant: "SYNUBERX EATS",
    });

    const [rulesBefore] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM classification_rules WHERE user_id = ${userId}
    `);

    const validated = await validateSynthesizedPattern({
      userId,
      pattern: "%SYNUBERX%",
      categorySlug: "uber-didi",
      coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
    });
    const result = await insertSynthesizedRuleProposal({
      userId,
      categorySlug: "uber-didi",
      pattern: validated.pattern,
      coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
      correctionTxnIds: [1, 2],
    });

    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") throw new Error("expected inserted");
    expect(result.pattern).toBe("%SYNUBERX%");
    expect(result.merchant).toBe("%SYNUBERX%");

    const [row] = await db.execute<{ status: string; source: string }>(sql`
      SELECT status::text, source::text FROM rule_proposals WHERE id = ${result.id}
    `);
    expect(row.status).toBe("pending");
    expect(row.source).toBe("synthesized");

    const [rulesAfter] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM classification_rules WHERE user_id = ${userId}
    `);
    expect(rulesAfter.n).toBe(rulesBefore.n);
  });

  it("still inserts a generalizing proposal when exact-merchant pending rows already exist", async () => {
    const userId = await createUser(`${TAG}-collide@test.local`);
    const accountId = await createAccount(userId);
    for (let i = 0; i < 20; i++) {
      await insertTx({ userId, accountId, descriptionRaw: `OTHER ${i}`, merchant: `OTHER ${i}` });
    }
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX TRIP",
      merchant: "SYNUBERX TRIP",
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX EATS",
      merchant: "SYNUBERX EATS",
    });

    await db.insert(ruleProposals).values([
      {
        userId,
        merchant: "SYNUBERX TRIP",
        pattern: "%SYNUBERX TRIP%",
        categorySlug: "uber-didi",
        correctionTxnIds: [1, 2, 3],
        status: "pending",
        source: "corrections",
      },
      {
        userId,
        merchant: "SYNUBERX EATS",
        pattern: "%SYNUBERX EATS%",
        categorySlug: "uber-didi",
        correctionTxnIds: [4, 5, 6],
        status: "pending",
        source: "corrections",
      },
    ]);

    const validated = await validateSynthesizedPattern({
      userId,
      pattern: "%SYNUBERX%",
      categorySlug: "uber-didi",
      coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
    });
    const result = await insertSynthesizedRuleProposal({
      userId,
      categorySlug: "uber-didi",
      pattern: validated.pattern,
      coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
      correctionTxnIds: [1, 2, 3, 4, 5, 6],
    });

    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") throw new Error("expected inserted");
    expect(result.pattern).toBe("%SYNUBERX%");
    expect(result.merchant).toBe("%SYNUBERX%");

    const pending = await db.execute<{ merchant: string; pattern: string; source: string }>(sql`
      SELECT merchant, pattern, source::text
      FROM rule_proposals
      WHERE user_id = ${userId} AND status = 'pending'
      ORDER BY source, merchant
    `);
    expect(pending).toHaveLength(3);
    expect(pending.filter((row) => row.source === "synthesized")).toEqual([
      { merchant: "%SYNUBERX%", pattern: "%SYNUBERX%", source: "synthesized" },
    ]);

    const again = await insertSynthesizedRuleProposal({
      userId,
      categorySlug: "uber-didi",
      pattern: validated.pattern,
      coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
      correctionTxnIds: [1, 2, 3, 4, 5, 6],
    });
    expect(again.status).toBe("duplicate");
  });

  it("re-validates on insert so a branded cast of '%' cannot be stored", async () => {
    const userId = await createUser(`${TAG}-cast@test.local`);
    await createAccount(userId);

    await expect(
      insertSynthesizedRuleProposal({
        userId,
        categorySlug: "uber-didi",
        pattern: "%" as ValidatedIlikePattern,
        coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
        correctionTxnIds: [],
      }),
    ).rejects.toBeInstanceOf(InvalidSynthesizedPatternError);

    const rows = await db.execute(sql`
      SELECT 1 FROM rule_proposals WHERE user_id = ${userId}
    `);
    expect(rows).toHaveLength(0);
  });

  it("database CHECK rejects a match-everything pattern even without the app guard", async () => {
    const userId = await createUser(`${TAG}-check@test.local`);
    await expect(
      db.execute(sql`
        INSERT INTO rule_proposals (user_id, merchant, pattern, category_slug, correction_txn_ids, source)
        VALUES (${userId}, 'X', '%', 'uber-didi', '[]'::jsonb, 'synthesized')
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        INSERT INTO rule_proposals (user_id, merchant, pattern, category_slug, correction_txn_ids, source)
        VALUES (${userId}, 'X', '%A%', 'uber-didi', '[]'::jsonb, 'synthesized')
      `),
    ).rejects.toThrow();
  });
});
