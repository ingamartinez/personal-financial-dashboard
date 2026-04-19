// Dev/local bootstrap seed. Composed of two layers:
//
// 1. Global reference data (category_seeds + classification_rule_seeds) —
//    delegated to `seedReferenceData()` in `seed-reference-data.ts`. That
//    same function is called from `scripts/migrate-prod.ts` after every
//    deploy so prod and dev stay in sync.
//
// 2. Dev-only bootstrap user + accounts + per-user copies of the seeds.
//    The bootstrap user comes from `BOOTSTRAP_USER_EMAIL`; accounts are a
//    hardcoded Colombian list that matches the operator's real banking.
//    Categories + classification_rules for the bootstrap user are
//    materialized via the same signup hooks new users hit on invite-code
//    registration, so there's exactly one code path.

import { eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { accounts, classificationRules, users, type AccountMetadata } from "./schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { seedReferenceData } from "./seed-reference-data";
import type { AccountType, Currency } from "@/lib/types";

const seedAccounts: Array<{
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  metadata?: AccountMetadata;
}> = [
  {
    name: "Bancolombia Ahorros",
    institution: "Bancolombia",
    type: "savings",
    currency: "COP",
    metadata: { last4s: ["6126", "1802"] },
  },
  {
    name: "ARQ Ahorros",
    institution: "ARQ",
    type: "savings",
    currency: "USD",
    metadata: { last4s: ["7073", "1356"] },
  },
  { name: "Efectivo COP", institution: "Cash", type: "savings", currency: "COP" },
  { name: "Efectivo USD", institution: "Cash", type: "savings", currency: "USD" },
  {
    name: "Bancolombia Visa *2575",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    metadata: { last4s: ["2575"], network: "visa" },
  },
  {
    name: "Bancolombia Mastercard *7291 (COP)",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    metadata: { last4s: ["7291"], network: "mastercard" },
  },
  {
    name: "Bancolombia Mastercard *7291 (USD)",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "USD",
    metadata: { last4s: ["7291"], network: "mastercard" },
  },
];

async function seedBootstrapUser(): Promise<number | null> {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim();
  const name = process.env.BOOTSTRAP_USER_NAME?.trim() || email;
  if (!email) {
    console.log("  BOOTSTRAP_USER_EMAIL not set — skipping bootstrap user");
    return null;
  }
  await db
    .insert(users)
    .values({ email, name: name ?? email })
    .onConflictDoNothing({ target: users.email });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  console.log(`  bootstrap user ensured for ${email} (id=${row?.id ?? "?"})`);
  return row?.id ?? null;
}

export async function runSeed() {
  console.log("seeding global reference data (category_seeds + classification_rule_seeds)...");
  const refResult = await seedReferenceData();
  console.log(
    `  reference data: ${refResult.categorySeeds} category seeds, ${refResult.ruleSeeds} rule seeds inserted (new rows only; existing are idempotent)`,
  );

  console.log("seeding bootstrap user...");
  const bootstrapUserId = await seedBootstrapUser();

  if (bootstrapUserId === null) {
    console.log("  skipping accounts + per-user seeds — no bootstrap user to attribute them to");
    return;
  }

  console.log("materializing per-user categories for bootstrap user...");
  const catCount = await copyCategorySeedsToUser(bootstrapUserId);
  console.log(`  inserted ${catCount} categories (skipped existing)`);

  console.log("seeding accounts for bootstrap user...");
  const existing = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(
      inArray(
        accounts.name,
        seedAccounts.map((a) => a.name),
      ),
    );
  const existingNames = new Set(existing.map((e) => e.name));
  const toInsert = seedAccounts.filter((a) => !existingNames.has(a.name));
  if (toInsert.length > 0) {
    await db.insert(accounts).values(toInsert.map((a) => ({ ...a, userId: bootstrapUserId })));
    console.log(`  inserted ${toInsert.length} new accounts`);
  } else {
    console.log("  all accounts already exist");
  }

  console.log("materializing per-user classification rules for bootstrap user...");
  const existingRuleCount = await db.$count(
    classificationRules,
    eq(classificationRules.userId, bootstrapUserId),
  );
  if (existingRuleCount === 0) {
    const ruleCount = await copyRuleSeedsToUser(bootstrapUserId);
    console.log(`  inserted ${ruleCount} classification rules`);
  } else {
    console.log(`  ${existingRuleCount} classification rules already present — skipping`);
  }

  console.log("done");
}

if (import.meta.main) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
