import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { loadPatternBlastRadius } from "./pattern-validation";
import { RULE_APPLY_WINDOW_DAYS, loadPatternApplyBlastRadius } from "./rule-apply-match";

const TAG = "SYN_APPLY_TEST";

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
  descriptionClean?: string | null;
  categorySlug?: string | null;
  daysAgo?: number;
}): Promise<number> {
  seq++;
  const occurredAt = new Date(Date.now() - (args.daysAgo ?? 0) * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt,
      amountCents: BigInt(-5000),
      currency: "COP",
      descriptionRaw: args.descriptionRaw,
      descriptionClean: args.descriptionClean ?? null,
      merchant: args.merchant ?? null,
      categorySlug: args.categorySlug === undefined ? "otros" : args.categorySlug,
      classificationMethod: args.categorySlug ? "manual" : "unclassified",
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

describe("loadPatternApplyBlastRadius", () => {
  it("pins the apply window the card and UPDATE share", () => {
    expect(RULE_APPLY_WINDOW_DAYS).toBe(90);
  });

  it("counts the apply set, not full-history description_raw matches", async () => {
    const userId = await createUser(`${TAG}-card@test.local`);
    const accountId = await createAccount(userId);

    const matchingId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX TRIP",
      descriptionClean: "SYNUBERX TRIP",
      merchant: "SYNUBERX TRIP",
      categorySlug: "otros",
      daysAgo: 5,
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX EATS",
      descriptionClean: "SYNUBERX EATS",
      merchant: "SYNUBERX EATS",
      categorySlug: "uber-didi",
      daysAgo: 5,
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SMS SYNUBERX CHARGE",
      merchant: "BANCOLOMBIA",
      descriptionClean: "BANCOLOMBIA",
      categorySlug: "otros",
      daysAgo: 5,
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "SYNUBERX OLD",
      descriptionClean: "SYNUBERX OLD",
      merchant: "SYNUBERX OLD",
      categorySlug: "otros",
      daysAgo: 120,
    });

    const apply = await loadPatternApplyBlastRadius(userId, "%SYNUBERX%", "uber-didi");
    expect(apply.matchCount).toBe(1);
    expect(apply.sample.map((s) => s.id)).toEqual([matchingId]);

    const history = await loadPatternBlastRadius(userId, "%SYNUBERX%");
    expect(history.matchCount).toBe(4);
  });
});
