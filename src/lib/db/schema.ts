import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const DISPLAY_CURRENCY_MODES = ["native", "all-cop", "all-usd"] as const;
export type DisplayCurrencyMode = (typeof DISPLAY_CURRENCY_MODES)[number];
export const DEFAULT_DISPLAY_CURRENCY_MODE: DisplayCurrencyMode = "native";

export type UiPreferences = {
  displayCurrencyMode?: DisplayCurrencyMode;
};

export type UserClassificationContextHint = {
  merchant: string;
  category: string;
  corrected_at: string;
};

export type UserClassificationContext = {
  merchant_hints?: UserClassificationContextHint[];
};

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    googleSub: varchar("google_sub", { length: 255 }).unique(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    pictureUrl: text("picture_url"),
    role: varchar("role", { length: 20 }).notNull().default("user"),
    active: boolean("active").notNull().default(true),
    uiPreferences: jsonb("ui_preferences").$type<UiPreferences>().notNull().default({}),
    classificationContext: jsonb("classification_context")
      .$type<UserClassificationContext>()
      .notNull()
      .default({}),
    // Phase 7 (SaaS productization) seam — all nullable, no defaults. Enforcement
    // lives in canIngest(userId) and is a no-op in v1. See PLAN.md § Business Model.
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    planId: varchar("plan_id", { length: 40 }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    mercadopagoCustomerId: varchar("mercadopago_customer_id", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('admin', 'user')`)],
);

export const inviteCodes = pgTable(
  "invite_codes",
  {
    code: varchar("code", { length: 32 }).primaryKey(),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    maxUses: integer("max_uses").notNull().default(1),
    usesCount: integer("uses_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("invite_codes_uses_count_check", sql`${t.usesCount} <= ${t.maxUses}`)],
);

export const webhookPurpose = pgEnum("webhook_purpose", ["sms", "debug"]);

export const webhookTokens = pgTable(
  "webhook_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: webhookPurpose("purpose").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    label: varchar("label", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_tokens_user_purpose_active_idx")
      .on(t.userId, t.purpose)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const accountType = pgEnum("account_type", ["savings", "credit_card", "loan"]);

export const institutionSlug = pgEnum("institution_slug", [
  "bancolombia",
  "davivienda",
  "nequi",
  "bbva",
  "scotiabank",
  "bancogalicia",
  "rappipay",
  "cash",
  "other",
]);

export const currency = pgEnum("currency", ["COP", "USD"]);

export const txSource = pgEnum("tx_source", [
  "apple_pay",
  "sms",
  "ocr",
  "csv",
  "recurring",
  "manual",
  "telegram",
  "balance_adjustment",
  "csv_reconcile",
]);

export const txChannel = pgEnum("tx_channel", ["bank", "manual", "transfer"]);

export const reconciliationStatus = pgEnum("reconciliation_status", [
  "unreconciled",
  "matched",
  "flagged",
  "imported_from_statement",
]);

export const classificationMethod = pgEnum("classification_method", [
  "rule",
  "rule_retroactive",
  "ai",
  "manual",
  "manual_confirmed",
  "unclassified",
]);

export const counterpartyType = pgEnum("counterparty_type", ["person", "merchant", "unknown"]);

export const ruleProposalStatus = pgEnum("rule_proposal_status", ["pending", "approved", "denied"]);

export const counterpartyKeyKind = pgEnum("counterparty_key_kind", [
  "qr",
  "breb",
  "account",
  "name",
]);

export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    institution: varchar("institution", { length: 50 }).notNull(),
    institutionSlug: institutionSlug("institution_slug").notNull().default("other"),
    type: accountType("type").notNull(),
    currency: currency("currency").notNull(),
    balanceCents: bigint("balance_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<AccountMetadata>().notNull().default({}),
    physicalCardId: uuid("physical_card_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("accounts_user_active_idx").on(t.userId, t.active),
    index("accounts_user_live_idx")
      .on(t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
    index("accounts_physical_card_live_idx")
      .on(t.physicalCardId)
      .where(sql`${t.physicalCardId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

export type AccountMetadata = {
  last4s?: string[];
  network?: "visa" | "mastercard" | "amex";
  creditLimitCents?: number;
  availableCreditCents?: number;
  cutoffDay?: number;
  paymentDueDay?: number;
  minPaymentCents?: number;
  totalPaymentCents?: number;
  loanOriginalCents?: number;
  loanRemainingCents?: number;
  interestRateMonthly?: number;
  termMonths?: number;
  monthlyPaymentCents?: number;
  interestPaidCents?: number;
  principalPaidCents?: number;
  nextPaymentDate?: string;
};

// Global immutable template for categories. Populated by `seedReferenceData()`
// on every deploy. Serves as the source for `copyCategorySeedsToUser(userId)`
// during signup — users get their own per-user copies in `categories` below.
export const categorySeeds = pgTable("category_seeds", {
  slug: varchar("slug", { length: 60 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  parentSlug: varchar("parent_slug", { length: 60 }).references(
    (): AnyPgColumn => categorySeeds.slug,
    { onDelete: "restrict" },
  ),
  icon: varchar("icon", { length: 40 }),
  color: varchar("color", { length: 20 }),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Per-user taxonomy. Each row belongs to exactly one user; slug is unique
// within a user but not globally (user A's "otros" and user B's "otros" are
// distinct rows). The self-FK on parent_slug is composite — a parent must
// belong to the same user.
export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 60 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    parentSlug: varchar("parent_slug", { length: 60 }),
    icon: varchar("icon", { length: 40 }),
    color: varchar("color", { length: 20 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("categories_user_slug_unique").on(t.userId, t.slug),
    foreignKey({
      columns: [t.userId, t.parentSlug],
      foreignColumns: [t.userId, t.slug],
      name: "categories_user_parent_fk",
    }).onDelete("restrict"),
    index("categories_user_live_idx")
      .on(t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const counterparties = pgTable(
  "counterparties",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    type: counterpartyType("type").notNull().default("unknown"),
    defaultCategorySlug: varchar("default_category_slug", { length: 60 }),
    notes: text("notes"),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("counterparties_user_display_idx").on(t.userId, t.displayName),
    foreignKey({
      columns: [t.userId, t.defaultCategorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "counterparties_user_category_fk",
    }).onDelete("set null"),
  ],
);

export const counterpartyAliases = pgTable(
  "counterparty_aliases",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    kind: counterpartyKeyKind("kind").notNull(),
    value: varchar("value", { length: 120 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("counterparty_aliases_user_kind_value_unique").on(t.userId, t.kind, t.value),
    index("counterparty_aliases_counterparty_idx").on(t.counterpartyId),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: currency("currency").notNull(),
    descriptionRaw: text("description_raw").notNull(),
    descriptionClean: text("description_clean"),
    merchant: varchar("merchant", { length: 200 }),
    categorySlug: varchar("category_slug", { length: 60 }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    classificationMethod: classificationMethod("classification_method")
      .notNull()
      .default("unclassified"),
    classificationConfidence: smallint("classification_confidence"),
    classificationReason: varchar("classification_reason", { length: 200 }),
    previousCategorySlug: varchar("previous_category_slug", { length: 60 }),
    retroactiveRuleId: integer("retroactive_rule_id").references(
      (): AnyPgColumn => classificationRules.id,
      { onDelete: "set null" },
    ),
    source: txSource("source").notNull(),
    channel: txChannel("channel").notNull().default("bank"),
    isAdjustment: boolean("is_adjustment").notNull().default(false),
    reconciliationStatus: reconciliationStatus("reconciliation_status")
      .notNull()
      .default("unreconciled"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    statementImportId: integer("statement_import_id").references(
      (): AnyPgColumn => statementImports.id,
      { onDelete: "set null" },
    ),
    externalId: varchar("external_id", { length: 200 }),
    recurringId: integer("recurring_id").references((): AnyPgColumn => recurringTransactions.id, {
      onDelete: "set null",
    }),
    recurringYearMonth: varchar("recurring_year_month", { length: 7 }),
    rawData: jsonb("raw_data").notNull().default({}),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_account_occurred_idx").on(t.accountId, t.occurredAt),
    index("transactions_user_occurred_idx").on(t.userId, t.occurredAt),
    index("transactions_user_category_idx").on(t.userId, t.categorySlug),
    index("transactions_user_counterparty_idx").on(t.userId, t.counterpartyId),
    index("transactions_account_recon_idx").on(t.accountId, t.reconciliationStatus, t.occurredAt),
    index("transactions_flagged_idx")
      .on(t.userId, t.occurredAt)
      .where(sql`${t.reconciliationStatus} = 'flagged'`),
    uniqueIndex("transactions_external_unique")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    uniqueIndex("transactions_recurring_unique")
      .on(t.recurringId, t.recurringYearMonth)
      .where(sql`${t.recurringId} IS NOT NULL`),
    foreignKey({
      columns: [t.userId, t.categorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "transactions_user_category_fk",
    }).onDelete("set null"),
  ],
);

export const statementImports = pgTable(
  "statement_imports",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    txnCount: integer("txn_count").notNull().default(0),
    balanceAtEndCents: bigint("balance_at_end_cents", { mode: "bigint" }),
  },
  (t) => [
    uniqueIndex("statement_imports_user_account_file_unique").on(t.userId, t.accountId, t.fileHash),
    index("statement_imports_account_period_idx").on(t.accountId, t.periodStart, t.periodEnd),
  ],
);

export const reconciliationDecisions = pgTable(
  "reconciliation_decisions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    txnId: integer("txn_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 32 }).notNull(),
    mergedIntoTxnId: integer("merged_into_txn_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [
    index("reconciliation_decisions_user_decided_idx").on(t.userId, t.decidedAt),
    index("reconciliation_decisions_txn_idx").on(t.txnId),
    check(
      "reconciliation_decisions_action_check",
      sql`${t.action} IN ('archived', 'kept', 'merged_into')`,
    ),
  ],
);

export const classificationRules = pgTable(
  "classification_rules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    categorySlug: varchar("category_slug", { length: 60 }).notNull(),
    priority: integer("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    autoGenerated: boolean("auto_generated").notNull().default(false),
    generatedFromCorrections: jsonb("generated_from_corrections").$type<number[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rules_user_priority_id_idx").on(t.userId, t.priority, t.id),
    uniqueIndex("rules_user_pattern_category_unique").on(t.userId, t.pattern, t.categorySlug),
    foreignKey({
      columns: [t.userId, t.categorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "classification_rules_user_category_fk",
    }).onDelete("cascade"),
  ],
);

// Global rule template; each row points at a category slug in `category_seeds`
// (also global). On signup, `copyRuleSeedsToUser(userId)` materializes a
// per-user copy in `classification_rules`, where the FK is composite against
// the user's own categories (populated first via copyCategorySeedsToUser).
export const classificationRuleSeeds = pgTable(
  "classification_rule_seeds",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull(),
    categorySlug: varchar("category_slug", { length: 60 })
      .notNull()
      .references(() => categorySeeds.slug, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("classification_rule_seeds_pattern_category_unique").on(t.pattern, t.categorySlug),
  ],
);

// Proposed auto-generated rules produced by the daily learning-loop cron when a
// user has corrected the same merchant → category 3+ times within 30 days. The
// partial unique index on (user_id, merchant, category_slug) filtered to
// status='pending' prevents the cron from re-proposing while a pending proposal
// is awaiting user decision. Denial suppresses re-proposal for 30d (enforced in
// the cron WHERE clause, not the index, so historic rows are retained).
export const ruleProposals = pgTable(
  "rule_proposals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchant: varchar("merchant", { length: 200 }).notNull(),
    categorySlug: varchar("category_slug", { length: 60 }).notNull(),
    correctionTxnIds: jsonb("correction_txn_ids").$type<number[]>().notNull(),
    status: ruleProposalStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("rule_proposals_user_merchant_category_pending_unique")
      .on(t.userId, t.merchant, t.categorySlug)
      .where(sql`${t.status} = 'pending'`),
    index("rule_proposals_user_status_idx").on(t.userId, t.status, t.createdAt),
    foreignKey({
      columns: [t.userId, t.categorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "rule_proposals_user_category_fk",
    }).onDelete("cascade"),
  ],
);

// Audit trail for every manual re-categorization. Feeds the learning loop:
// a daily cron groups by (user_id, merchant, new_category_slug) and proposes
// a rule when a user has corrected the same merchant → same category 3+ times
// in 30 days. See #317 for the learning-loop consumer.
export const classificationCorrections = pgTable(
  "classification_corrections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    merchant: varchar("merchant", { length: 200 }),
    previousCategorySlug: varchar("previous_category_slug", { length: 60 }),
    newCategorySlug: varchar("new_category_slug", { length: 60 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("classification_corrections_learning_idx").on(
      t.userId,
      t.merchant,
      t.newCategorySlug,
      t.createdAt,
    ),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categorySlug: varchar("category_slug", { length: 60 }).notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: currency("currency").notNull().default("COP"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("budgets_user_period_idx").on(t.userId, t.periodStart),
    index("budgets_user_period_live_idx")
      .on(t.userId, t.periodStart)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      columns: [t.userId, t.categorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "budgets_user_category_fk",
    }).onDelete("cascade"),
  ],
);

export const recurringTransactions = pgTable(
  "recurring_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: currency("currency").notNull(),
    categorySlug: varchar("category_slug", { length: 60 }),
    dayOfMonth: smallint("day_of_month").notNull(),
    active: boolean("active").notNull().default(true),
    lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
    skippedMonths: jsonb("skipped_months").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("recurring_tx_user_day_idx").on(t.userId, t.dayOfMonth),
    index("recurring_tx_user_day_live_idx")
      .on(t.userId, t.dayOfMonth)
      .where(sql`${t.deletedAt} IS NULL`),
    foreignKey({
      columns: [t.userId, t.categorySlug],
      foreignColumns: [categories.userId, categories.slug],
      name: "recurring_transactions_user_category_fk",
    }).onDelete("set null"),
  ],
);

export const recurringGaps = pgTable(
  "recurring_gaps",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recurringId: integer("recurring_id")
      .notNull()
      .references(() => recurringTransactions.id, { onDelete: "cascade" }),
    yearMonth: varchar("year_month", { length: 7 }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recurring_gaps_recurring_month_unique").on(t.recurringId, t.yearMonth),
    index("recurring_gaps_detected_idx").on(t.detectedAt),
    index("recurring_gaps_user_detected_idx").on(t.userId, t.detectedAt),
  ],
);

export const ingestionLogs = pgTable(
  "ingestion_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: txSource("source").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    itemsReceived: integer("items_received").notNull().default(0),
    itemsInserted: integer("items_inserted").notNull().default(0),
    itemsDuplicated: integer("items_duplicated").notNull().default(0),
    errorMessage: text("error_message"),
    payload: jsonb("payload"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Resolution surface for the Ingestion Inbox (#261). A row is "unresolved" when
    // status='error' AND resolved_at IS NULL. Retry/dismiss actions set all three.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedTxnId: integer("resolved_txn_id").references((): AnyPgColumn => transactions.id, {
      onDelete: "set null",
    }),
    resolution: varchar("resolution", { length: 20 }), // 'retried_success' | 'retried_failed' | 'dismissed'
  },
  (t) => [
    index("ingestion_logs_user_started_idx").on(t.userId, t.startedAt),
    index("ingestion_logs_user_unresolved_idx")
      .on(t.userId, t.startedAt)
      .where(sql`${t.status} = 'error' AND ${t.resolvedAt} IS NULL`),
  ],
);

export const insightsReports = pgTable(
  "insights_reports",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    yearMonth: varchar("year_month", { length: 7 }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    markdown: text("markdown").notNull(),
    model: varchar("model", { length: 50 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  (t) => [uniqueIndex("insights_reports_user_year_month_unique").on(t.userId, t.yearMonth)],
);

export const fxRates = pgTable(
  "fx_rates",
  {
    id: serial("id").primaryKey(),
    base: varchar("base", { length: 3 }).notNull(),
    quote: varchar("quote", { length: 3 }).notNull(),
    rateMicros: bigint("rate_micros", { mode: "bigint" }).notNull(),
    asOf: date("as_of").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    source: varchar("source", { length: 40 }).notNull(),
  },
  (t) => [
    uniqueIndex("fx_rates_pair_asof_unique").on(t.base, t.quote, t.asOf),
    index("fx_rates_pair_fetched_idx").on(t.base, t.quote, t.fetchedAt),
  ],
);

export const accountSnapshots = pgTable(
  "account_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [uniqueIndex("snapshots_account_date_unique").on(t.accountId, t.snapshotDate)],
);

export type TelegramSessionStep =
  | "idle"
  | "awaiting_account"
  | "awaiting_amount"
  | "awaiting_category"
  | "awaiting_confirm"
  | "awaiting_photo_account"
  | "awaiting_batch_confirm";

export type TelegramBatchItem = {
  draft: TelegramDraft;
  externalId: string;
};

export type TelegramDraft = {
  amountCents?: string;
  currency?: "COP" | "USD";
  direction?: "expense" | "income";
  merchant?: string;
  description?: string;
  occurredOn?: string;
  accountId?: number;
  categorySlug?: string;
  notes?: string;
};

export type TelegramSessionState = {
  step: TelegramSessionStep;
  draft: TelegramDraft;
  sourceChatId: number;
  sourceMessageId?: number;
  promptMessageId?: number;
  externalIdOverride?: string;
  photoFileId?: string;
  batch?: TelegramBatchItem[];
};

export const telegramBots = pgTable("telegram_bots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenEncrypted: text("token_encrypted").notNull(),
  username: varchar("username", { length: 64 }).notNull(),
  webhookSecret: varchar("webhook_secret", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramSessions = pgTable(
  "telegram_sessions",
  {
    chatId: bigint("chat_id", { mode: "bigint" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    state: jsonb("state").$type<TelegramSessionState>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("telegram_sessions_user_idx").on(t.userId)],
);

export type CaptureSources30d = Partial<Record<(typeof txSource.enumValues)[number], number>>;

// AI canary — shadow-parses a deterministic 1% sample of incoming SMS via
// Haiku and compares against the regex result. Detects Bancolombia format
// drift before users notice. See PLAN.md § AI Strategy + issue #258.
//
// regexResult / aiResult shape is CanaryProjection — { amountCents, currency,
// merchant, occurredOn } — see src/lib/observability/canary.ts.
export type CanaryProjection = {
  amountCents: string | null;
  currency: "COP" | "USD" | null;
  merchant: string | null;
  occurredOn: string | null;
};

export const parserCanaryEvents = pgTable(
  "parser_canary_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    smsBodyHash: varchar("sms_body_hash", { length: 64 }).notNull(),
    sender: varchar("sender", { length: 100 }),
    regexResult: jsonb("regex_result").$type<CanaryProjection>().notNull(),
    aiResult: jsonb("ai_result").$type<CanaryProjection>().notNull(),
    agreement: boolean("agreement").notNull(),
    divergenceFields: jsonb("divergence_fields").$type<string[]>().notNull().default([]),
    aiModel: varchar("ai_model", { length: 50 }).notNull(),
    aiInputTokens: integer("ai_input_tokens").notNull().default(0),
    aiOutputTokens: integer("ai_output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("parser_canary_events_created_idx").on(t.createdAt),
    index("parser_canary_events_disagree_idx")
      .on(t.createdAt)
      .where(sql`${t.agreement} = false`),
  ],
);

// Insert-only alert log with built-in dedup. Rules for the dispatcher:
//   - Never fire a new alert if another is unresolved (resolvedAt IS NULL)
//   - When rate recovers ≥ threshold, mark the most recent unresolved row as resolved
// This gives us history + natural dedup without a separate state table.
export const canaryAlerts = pgTable(
  "canary_alerts",
  {
    id: serial("id").primaryKey(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    rate: numeric("rate", { precision: 5, scale: 4 }).notNull(),
    samples: integer("samples").notNull(),
    topDivergences: jsonb("top_divergences").notNull().default([]),
    notificationStatus: varchar("notification_status", { length: 40 }).notNull(),
  },
  (t) => [
    index("canary_alerts_unresolved_idx")
      .on(t.firedAt)
      .where(sql`${t.resolvedAt} IS NULL`),
  ],
);

export const userHealthSnapshots = pgTable(
  "user_health_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    lastSmsReceivedAt: timestamp("last_sms_received_at", { withTimezone: true }),
    lastCaptureAt: timestamp("last_capture_at", { withTimezone: true }),
    captureSources30d: jsonb("capture_sources_30d")
      .$type<CaptureSources30d>()
      .notNull()
      .default({}),
    // NULL when user had zero ingest attempts in the 30d window — avoids
    // painting green dashboards for dormant users.
    parserSuccessRate30d: numeric("parser_success_rate_30d", { precision: 5, scale: 4 }),
    unreconciledTxnCount: integer("unreconciled_txn_count").notNull().default(0),
    // Sum of `is_adjustment = true` txn amounts in the last 30d — measures
    // how much the user has corrected findash via balance adjustments.
    divergenceCents: bigint("divergence_cents", { mode: "bigint" }),
    // Sum of (accounts.balance_cents − latest statement_imports.balance_at_end_cents)
    // across accounts whose most recent 30d statement import carries a balance —
    // measures the remaining gap between findash and reality per #304.
    // NULL until a statement import with a user-provided balance lands.
    statementDivergenceCents: bigint("statement_divergence_cents", { mode: "bigint" }),
    churnSignalFlag: boolean("churn_signal_flag").notNull().default(false),
  },
  (t) => [
    index("user_health_snapshots_user_captured_idx").on(t.userId, t.capturedAt),
    index("user_health_snapshots_churn_idx")
      .on(t.capturedAt)
      .where(sql`${t.churnSignalFlag} = true`),
  ],
);
