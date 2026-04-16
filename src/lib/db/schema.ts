import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
  varchar,
} from "drizzle-orm/pg-core";

export const accountType = pgEnum("account_type", [
  "savings",
  "credit_card",
  "loan",
]);

export const currency = pgEnum("currency", ["COP", "USD"]);

export const txSource = pgEnum("tx_source", [
  "apple_pay",
  "sms",
  "ocr",
  "csv",
  "recurring",
  "manual",
]);

export const classificationMethod = pgEnum("classification_method", [
  "rule",
  "ai",
  "manual",
  "unclassified",
]);

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  institution: varchar("institution", { length: 50 }).notNull(),
  type: accountType("type").notNull(),
  currency: currency("currency").notNull(),
  balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull().default(sql`0`),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<AccountMetadata>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  parentSlug: varchar("parent_slug", { length: 60 }),
  icon: varchar("icon", { length: 40 }),
  color: varchar("color", { length: 20 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    currency: currency("currency").notNull(),
    descriptionRaw: text("description_raw").notNull(),
    descriptionClean: text("description_clean"),
    merchant: varchar("merchant", { length: 200 }),
    categorySlug: varchar("category_slug", { length: 60 }).references(
      () => categories.slug,
      { onDelete: "set null" },
    ),
    classificationMethod: classificationMethod("classification_method")
      .notNull()
      .default("unclassified"),
    classificationConfidence: smallint("classification_confidence"),
    source: txSource("source").notNull(),
    externalId: varchar("external_id", { length: 200 }),
    rawData: jsonb("raw_data").notNull().default({}),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_account_occurred_idx").on(t.accountId, t.occurredAt),
    index("transactions_category_idx").on(t.categorySlug),
    index("transactions_occurred_idx").on(t.occurredAt),
    uniqueIndex("transactions_external_unique")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  ],
);

export const classificationRules = pgTable(
  "classification_rules",
  {
    id: serial("id").primaryKey(),
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
  (t) => [index("rules_priority_idx").on(t.priority)],
);

export const budgets = pgTable("budgets", {
  id: serial("id").primaryKey(),
  categorySlug: varchar("category_slug", { length: 60 })
    .notNull()
    .references(() => categories.slug, { onDelete: "cascade" }),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  currency: currency("currency").notNull().default("COP"),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recurringTransactions = pgTable("recurring_transactions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 120 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  currency: currency("currency").notNull(),
  categorySlug: varchar("category_slug", { length: 60 }).references(
    () => categories.slug,
    { onDelete: "set null" },
  ),
  dayOfMonth: smallint("day_of_month").notNull(),
  active: boolean("active").notNull().default(true),
  lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
  skippedMonths: jsonb("skipped_months").$type<string[]>().notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestionLogs = pgTable("ingestion_logs", {
  id: serial("id").primaryKey(),
  source: txSource("source").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  itemsReceived: integer("items_received").notNull().default(0),
  itemsInserted: integer("items_inserted").notNull().default(0),
  itemsDuplicated: integer("items_duplicated").notNull().default(0),
  errorMessage: text("error_message"),
  payload: jsonb("payload"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const insightsReports = pgTable("insights_reports", {
  id: serial("id").primaryKey(),
  yearMonth: varchar("year_month", { length: 7 }).notNull().unique(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  markdown: text("markdown").notNull(),
  model: varchar("model", { length: 50 }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
});

export const accountSnapshots = pgTable(
  "account_snapshots",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    uniqueIndex("snapshots_account_date_unique").on(t.accountId, t.snapshotDate),
  ],
);
