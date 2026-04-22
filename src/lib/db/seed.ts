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

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createLogger } from "@/lib/logger";
import { db } from "./index";
import {
  accounts,
  classificationRules,
  physicalCards,
  users,
  type AccountMetadata,
} from "./schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { seedReferenceData } from "./seed-reference-data";
import type { AccountType, Currency } from "@/lib/types";

const log = createLogger({ module: "seed" });

type InstitutionSlug = (typeof accounts.$inferInsert)["institutionSlug"];

// Sub-accounts sharing a `physicalCardGroup` value are multi-currency cards
// (#346): runSeed creates one row in `physical_cards` per group and links
// every matching account's `physical_card_id` to it.
const seedAccounts: Array<{
  name: string;
  institution: string;
  institutionSlug: InstitutionSlug;
  type: AccountType;
  currency: Currency;
  metadata?: AccountMetadata;
  physicalCardGroup?: string;
}> = [
  {
    name: "Bancolombia Ahorros",
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    type: "savings",
    currency: "COP",
    metadata: { last4s: ["6126", "1802"] },
  },
  {
    name: "ARQ Ahorros",
    institution: "ARQ",
    institutionSlug: "other",
    type: "savings",
    currency: "USD",
    metadata: { last4s: ["7073", "1356"] },
  },
  {
    name: "Efectivo COP",
    institution: "Cash",
    institutionSlug: "cash",
    type: "savings",
    currency: "COP",
  },
  {
    name: "Efectivo USD",
    institution: "Cash",
    institutionSlug: "cash",
    type: "savings",
    currency: "USD",
  },
  {
    name: "Bancolombia Visa *2575",
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    type: "credit_card",
    currency: "COP",
    // #406/#411: default EM rate buckets observed on Bancolombia 2026 extracts.
    // Stored as percent × 10000 — 19110 = 1.9110% EM ≈ 25.50% EA for the
    // 2-36 cuota bucket; 0 for diferido-sin-intereses. User can override
    // per-account from /settings.
    metadata: {
      last4s: ["2575"],
      network: "visa",
      creditRateBuckets: { oneMonth: 0, months2to36: 19110, advances: 19110 },
      // #413: statement cut day drives the intereses-causados job's anchor.
      // 30 matches the observed Bancolombia 2026 extracts; users edit per TC
      // from /settings/accounts.
      cutoffDay: 30,
    },
  },
  {
    name: "Bancolombia Mastercard *7291",
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    type: "credit_card",
    currency: "COP",
    metadata: {
      last4s: ["7291"],
      network: "mastercard",
      creditRateBuckets: { oneMonth: 0, months2to36: 19110, advances: 19110 },
    },
    physicalCardGroup: "bancolombia-mc-7291",
  },
  {
    name: "Bancolombia Mastercard *7291",
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    type: "credit_card",
    currency: "USD",
    metadata: {
      last4s: ["7291"],
      network: "mastercard",
      creditRateBuckets: { oneMonth: 0, months2to36: 19110, advances: 19110 },
    },
    physicalCardGroup: "bancolombia-mc-7291",
  },
];

async function seedBootstrapUser(): Promise<number | null> {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim();
  const name = process.env.BOOTSTRAP_USER_NAME?.trim() || email;
  if (!email) {
    log.info({ event: "bootstrap_user_skipped" }, "BOOTSTRAP_USER_EMAIL not set");
    return null;
  }
  await db
    .insert(users)
    .values({ email, name: name ?? email })
    .onConflictDoNothing({ target: users.email });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  log.info(
    { email, userId: row?.id ?? null, event: "bootstrap_user_ensured" },
    "bootstrap user ensured",
  );
  return row?.id ?? null;
}

export async function runSeed() {
  log.info({ event: "seed_reference_start" }, "seeding global reference data");
  const refResult = await seedReferenceData();
  log.info(
    {
      categorySeeds: refResult.categorySeeds,
      ruleSeeds: refResult.ruleSeeds,
      event: "seed_reference_done",
    },
    "reference data inserted (idempotent)",
  );

  log.info({ event: "seed_bootstrap_start" }, "seeding bootstrap user");
  const bootstrapUserId = await seedBootstrapUser();

  if (bootstrapUserId === null) {
    log.info(
      { event: "seed_skip_per_user" },
      "skipping accounts + per-user seeds — no bootstrap user",
    );
    return;
  }

  log.info({ userId: bootstrapUserId, event: "seed_categories_start" }, "materializing categories");
  const catCount = await copyCategorySeedsToUser(bootstrapUserId);
  log.info(
    { count: catCount, userId: bootstrapUserId, event: "seed_categories_done" },
    `inserted ${catCount} categories (skipped existing)`,
  );

  log.info({ userId: bootstrapUserId, event: "seed_accounts_start" }, "seeding accounts");
  // Match on (userId, name, currency) so we don't re-seed the COP + USD halves
  // of a multi-currency pair as a single-row duplicate (both share a name).
  const existing = await db
    .select({ name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, bootstrapUserId),
        inArray(
          accounts.name,
          seedAccounts.map((a) => a.name),
        ),
      ),
    );
  const existingKeys = new Set(existing.map((e) => `${e.name}|${e.currency}`));
  const toInsert = seedAccounts.filter((a) => !existingKeys.has(`${a.name}|${a.currency}`));

  // Assign (or reuse) a physical_card row per `physicalCardGroup`. Groups with
  // no pre-existing sub-accounts get a fresh uuid + physical_cards insert; if
  // the first half already exists, we reuse its physicalCardId so re-seeding
  // the remaining half doesn't create a second orphaned parent row.
  const groupToPhysicalCardId = new Map<string, string>();
  const newPhysicalCardRows: Array<typeof physicalCards.$inferInsert> = [];
  for (const acc of seedAccounts) {
    if (!acc.physicalCardGroup || groupToPhysicalCardId.has(acc.physicalCardGroup)) continue;
    const [liveSibling] = await db
      .select({ id: accounts.physicalCardId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, bootstrapUserId),
          eq(accounts.name, acc.name),
          eq(accounts.currency, acc.currency),
        ),
      );
    if (liveSibling?.id) {
      groupToPhysicalCardId.set(acc.physicalCardGroup, liveSibling.id);
      continue;
    }
    const id = randomUUID();
    groupToPhysicalCardId.set(acc.physicalCardGroup, id);
    newPhysicalCardRows.push({
      id,
      userId: bootstrapUserId,
      institution: acc.institution,
      institutionSlug: acc.institutionSlug,
      network: acc.metadata?.network,
      last4: acc.metadata?.last4s?.[0],
      creditLimitCents: BigInt(0),
      // #413: default statement cut day from observed Bancolombia 2026
      // extracts. Users edit per TC from /settings/accounts.
      statementCutoffDay: 30,
    });
  }
  if (newPhysicalCardRows.length > 0) {
    await db.insert(physicalCards).values(newPhysicalCardRows).onConflictDoNothing();
    log.info(
      { count: newPhysicalCardRows.length, event: "seed_physical_cards_inserted" },
      `inserted ${newPhysicalCardRows.length} physical_cards rows (cupo=0, user edits via UI)`,
    );
  }

  if (toInsert.length > 0) {
    await db.insert(accounts).values(
      toInsert.map((a) => ({
        ...a,
        userId: bootstrapUserId,
        physicalCardId: a.physicalCardGroup
          ? (groupToPhysicalCardId.get(a.physicalCardGroup) ?? null)
          : null,
      })),
    );
    log.info(
      { count: toInsert.length, event: "seed_accounts_inserted" },
      `inserted ${toInsert.length} new accounts`,
    );
  } else {
    log.info({ event: "seed_accounts_all_exist" }, "all accounts already exist");
  }

  log.info({ userId: bootstrapUserId, event: "seed_rules_start" }, "materializing rules");
  const existingRuleCount = await db.$count(
    classificationRules,
    eq(classificationRules.userId, bootstrapUserId),
  );
  if (existingRuleCount === 0) {
    const ruleCount = await copyRuleSeedsToUser(bootstrapUserId);
    log.info(
      { count: ruleCount, event: "seed_rules_inserted" },
      `inserted ${ruleCount} classification rules`,
    );
  } else {
    log.info(
      { existing: existingRuleCount, event: "seed_rules_skipped" },
      `${existingRuleCount} classification rules already present — skipping`,
    );
  }

  log.info({ event: "seed_done" }, "done");
}

if (import.meta.main) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err, event: "seed_failed" }, "seed failed");
      process.exit(1);
    });
}
