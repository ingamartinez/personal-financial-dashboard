import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
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

export const currency = pgEnum("currency", ["COP", "USD"]);

export const txSource = pgEnum("tx_source", [
  "apple_pay",
  "sms",
  "ocr",
  "csv",
  "recurring",
  "manual",
  "telegram",
]);

export const classificationMethod = pgEnum("classification_method", [
  "rule",
  "ai",
  "manual",
  "unclassified",
]);

export const counterpartyType = pgEnum("counterparty_type", ["person", "merchant", "unknown"]);

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

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 60 }).notNull().unique(),
  name: varchar("name", { length: 80 }).notNull(),
  parentSlug: varchar("parent_slug", { length: 60 }).references(
    (): AnyPgColumn => categories.slug,
    {
      onDelete: "restrict",
    },
  ),
  icon: varchar("icon", { length: 40 }),
  color: varchar("color", { length: 20 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const counterparties = pgTable(
  "counterparties",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    type: counterpartyType("type").notNull().default("unknown"),
    defaultCategorySlug: varchar("default_category_slug", { length: 60 }).references(
      () => categories.slug,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("counterparties_user_display_idx").on(t.userId, t.displayName)],
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
    categorySlug: varchar("category_slug", { length: 60 }).references(() => categories.slug, {
      onDelete: "set null",
    }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    classificationMethod: classificationMethod("classification_method")
      .notNull()
      .default("unclassified"),
    classificationConfidence: smallint("classification_confidence"),
    source: txSource("source").notNull(),
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
    uniqueIndex("transactions_external_unique")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    uniqueIndex("transactions_recurring_unique")
      .on(t.recurringId, t.recurringYearMonth)
      .where(sql`${t.recurringId} IS NOT NULL`),
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
    categorySlug: varchar("category_slug", { length: 60 })
      .notNull()
      .references(() => categories.slug, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rules_user_priority_id_idx").on(t.userId, t.priority, t.id),
    uniqueIndex("rules_user_pattern_category_unique").on(t.userId, t.pattern, t.categorySlug),
  ],
);

export const classificationRuleSeeds = pgTable("classification_rule_seeds", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull(),
  categorySlug: varchar("category_slug", { length: 60 })
    .notNull()
    .references(() => categories.slug, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const budgets = pgTable(
  "budgets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categorySlug: varchar("category_slug", { length: 60 })
      .notNull()
      .references(() => categories.slug, { onDelete: "cascade" }),
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
    categorySlug: varchar("category_slug", { length: 60 }).references(() => categories.slug, {
      onDelete: "set null",
    }),
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
  },
  (t) => [index("ingestion_logs_user_started_idx").on(t.userId, t.startedAt)],
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
