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

export const FINANCIAL_CYCLE_MODES = ["calendar", "pay_period"] as const;
export type FinancialCycleMode = (typeof FINANCIAL_CYCLE_MODES)[number];
export const DEFAULT_FINANCIAL_CYCLE_MODE: FinancialCycleMode = "calendar";

export type UiPreferences = {
  displayCurrencyMode?: DisplayCurrencyMode;
  // #493: opt-in toggle. When "pay_period" the dashboard / budgets / insights
  // anchor month boundaries on detected salary income instead of the calendar
  // month. Defaults to "calendar" — irregular-income users (freelancers, gig
  // workers, multi-source) keep the original behavior.
  financialCycleMode?: FinancialCycleMode;
  // #493: dashboard one-time nudge dismissal. Once true the banner that
  // suggests turning on pay_period mode never re-appears, even if the user
  // later flips back to calendar mode.
  payPeriodNudgeDismissed?: boolean;
};

// Per-user feature toggles. Default for every flag is "inherit from process
// env" — per-feature env vars act as the global default and each user can
// override explicitly via the `/settings` UI (future work). Prefer adding
// new fields here over new columns.
export type UserFeatureFlags = {
  // AI fallback for SMS needs_review path (#257). If unset, uses
  // AI_FALLBACK_ENABLED env var. If set, user's preference wins.
  aiFallbackEnabled?: boolean;
};

export type UserClassificationContextHint = {
  merchant: string;
  category: string;
  corrected_at: string;
};

export type UserClassificationContext = {
  merchant_hints?: UserClassificationContextHint[];
};

// #457 (Epic G): captured when SMS and Email Bancolombia describe the same
// event with diverging fields. Populated by the A+ dedup pipeline so the
// divergence is auditable instead of silently overwritten. Cleared when the
// user manually resolves the tx.
export type SourceMismatchDetails = {
  fromSource: string;
  toSource: string;
  diffs: Array<{
    field: string;
    fromValue: unknown;
    toValue: unknown;
  }>;
};

// #453/#457 (Epic G): structured payload extracted by gateway parsers from
// raw HTML email receipts. The shape varies per gateway, so this is the
// minimum common contract — parsers may include additional gateway-specific
// fields under `extra`.
export type ParsedReceiptPayload = {
  merchant: string;
  amountCents: string; // bigint serialized for JSON
  currency: string;
  occurredAt: string; // ISO timestamp
  referenceId: string | null;
  extra?: Record<string, unknown>;
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
    featureFlags: jsonb("feature_flags").$type<UserFeatureFlags>().notNull().default({}),
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

export const webhookPurpose = pgEnum("webhook_purpose", ["sms", "debug", "widget"]);

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
  // #457 (Epic G): tx ingested from Bancolombia notification email — parallel
  // to "sms", deduped via A+ (first-in wins, log diffs).
  "gmail_bancolombia",
  // #454 (Epic G): tx whose merchant was enriched from a gateway email
  // receipt (MP/PayU/Wompi/Apple/PayPal). The original bank-derived row was
  // already inserted via another source — this value applies only to txs
  // that were CREATED by the Gmail pipeline (rare, e.g. statement-only
  // gateways). For enrichment of existing txs, see `enrichment_source`
  // column on transactions.
  "gmail_enrichment",
  // #508 (Epic ARQ): tx ingested from ARQ (formerly DolarApp) notification
  // email — USD transfers (salary + outgoing). No SMS parallel channel.
  "gmail_arq",
  // #517 (Epic ARQ): tx inserted from ARQ monthly statement PDF — covers
  // purchases, fees, cashback, and p2p transfers that email did NOT capture.
  // Txs already present via gmail_arq are MERGED (not duplicated); this source
  // is only written on INSERTs (statement-only events).
  "arq_statement",
]);

export const txChannel = pgEnum("tx_channel", ["bank", "manual", "transfer"]);

export const reconciliationStatus = pgEnum("reconciliation_status", [
  "unreconciled",
  "matched",
  "flagged",
  "imported_from_statement",
]);

// #418: discriminates between the two xlsx exports Bancolombia produces:
// "movimientos" = operational account history (src/lib/reconciliation parsers);
// "extracto_detallado" = TC monthly statement with installments+rate+cycle
// metadata (src/lib/ingestion/bancolombia-statement parser, #417).
export const statementImportKind = pgEnum("statement_import_kind", [
  "movimientos",
  "extracto_detallado",
]);

export const classificationMethod = pgEnum("classification_method", [
  "rule",
  "rule_retroactive",
  "ai",
  "manual",
  "manual_confirmed",
  "unclassified",
  "user_uncategorized",
]);

export const counterpartyType = pgEnum("counterparty_type", ["person", "merchant", "unknown"]);

export const ruleProposalStatus = pgEnum("rule_proposal_status", ["pending", "approved", "denied"]);

export const counterpartyKeyKind = pgEnum("counterparty_key_kind", [
  "qr",
  "breb",
  "account",
  "name",
]);

// #451 (Epic G): lifecycle of a Gmail OAuth connection. `expired` covers
// Google testing-mode 7-day refresh-token expiry. `revoked` means the user
// disconnected on our side or revoked from Google. `error` is set after
// repeated pull failures with a non-recoverable cause.
export const gmailConnectionStatus = pgEnum("gmail_connection_status", [
  "active",
  "expired",
  "revoked",
  "error",
]);

// #453/#457 (Epic G): identifies which gateway parser produced the receipt.
export const emailReceiptGateway = pgEnum("email_receipt_gateway", [
  "mercado_pago",
  "payu",
  "wompi",
  "apple",
  "paypal",
  "bancolombia",
  "arq",
]);

// #454 (Epic G): matcher outcome between an email receipt and existing
// transactions. `pending` is the initial state before the matcher runs.
// `unmatched` may flip to `matched` later if the corresponding bank tx
// arrives via SMS/Apple Pay (re-attempted on subsequent pulls).
export const emailReceiptMatchStatus = pgEnum("email_receipt_match_status", [
  "pending",
  "matched",
  "ambiguous",
  "unmatched",
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
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<AccountMetadata>().notNull().default({}),
    physicalCardId: uuid("physical_card_id").references((): AnyPgColumn => physicalCards.id, {
      onDelete: "set null",
    }),
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

// #406/#411: per-bucket monthly effective interest rates for a credit card.
// Values are ALWAYS Efectiva Mensual Vencida (EM / MV), stored as
// "percent × 10000" to preserve the 4 decimals Bancolombia prints on real
// extracts (e.g. "1.9110%" → 19110). Display as EA is computed on read only
// — NEVER store EA here. Conversion: fractional = stored / 1_000_000;
// EA = (1 + fractional)^12 - 1.
//
// Why per-bucket: Bancolombia extracts show distinct rates for
//   - compra a 1 cuota (typically 0% — diferido sin intereses)
//   - compra a 2-36 cuotas (the "full" rate)
//   - advances / impuestos / mora (often the same as 2-36)
// Purchase-time rate is snapshotted on the transaction (see
// `transactions.installment_rate_em_x10k`); a null on the tx falls back to
// the bucket that matches `installments_total` at compute time.
export type CreditRateBucketsEM = {
  oneMonth: number; // stored = percent × 10000 — typical 0 (diferido sin intereses)
  months2to36: number; // stored = percent × 10000 — typical 19110 (= 1.9110% EM ≈ 25.50% EA)
  advances: number; // stored = percent × 10000 — typical == months2to36 at this bank
};

export type AccountMetadata = {
  last4s?: string[];
  network?: "visa" | "mastercard" | "amex";
  creditLimitCents?: number;
  /**
   * @deprecated #420 — do NOT read. Display always derives cupo disponible
   * from `creditLimitCents + derivedBalance(SUM(ledger))`. Field kept in the
   * type for backwards-compat with legacy JSONB rows; `adjustAccountBalance`
   * strips it on the next balance-adjust so it drains orgánicamente.
   */
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
  // #406: see `CreditRateBucketsEM` above — EM/MV rates in bps for each
  // purchase bucket. Populated by the account editor for credit_card accounts.
  creditRateBuckets?: CreditRateBucketsEM;
  // Captured by migration 0036 when stripping ` (COP)` / ` (USD)` suffixes that
  // were used as a pre-helper hack to disambiguate multi-currency cards.
  legacyNameSuffix?: string;
};

// One row per physical plastic for multi-currency credit cards where the bank
// shares a single COP cupo across COP+USD balances (e.g. Bancolombia Mastercard
// Internacional, Amex). Linked `accounts` rows carry the per-currency balance
// and per-currency statement attributes; this table owns the shared cupo.
// Single-currency credit cards stay on `accounts.metadata.creditLimitCents`
// for now — they are intentionally NOT migrated here (#346).
export type PhysicalCardMetadata = {
  coalescedFrom?: number[];
};

export const physicalCards = pgTable(
  "physical_cards",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    institution: varchar("institution", { length: 50 }).notNull(),
    institutionSlug: institutionSlug("institution_slug").notNull().default("other"),
    name: varchar("name", { length: 100 }),
    network: varchar("network", { length: 20 }),
    last4: varchar("last4", { length: 4 }),
    creditLimitCents: bigint("credit_limit_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    statementCutoffDay: smallint("statement_cutoff_day"),
    metadata: jsonb("metadata").$type<PhysicalCardMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("physical_cards_user_idx").on(t.userId),
    index("physical_cards_user_institution_idx").on(t.userId, t.institutionSlug),
  ],
);

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
    // #493: orthogonal to `type` — your employer is a `merchant` AND
    // `isSalary=true`. Drives the pay-period anchoring helper. A counterparty
    // can be flagged regardless of `type`; the helper only looks at this flag
    // plus the user's `financialCycleMode` preference.
    isSalary: boolean("is_salary").notNull().default(false),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("counterparties_user_display_idx").on(t.userId, t.displayName),
    // Partial index — most counterparties are NOT salary, so we only pay the
    // index cost for the rows the period helper actually scans.
    index("counterparties_user_salary_idx")
      .on(t.userId)
      .where(sql`${t.isSalary} = true`),
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
    // #406: installment plan for credit-card purchases. Inmutable post-insert
    // (re-installmentizing creates a new transfer group per the modo-B model,
    // not a mutation — see parent #345). Default 1 means "single payment, no
    // financing".
    installmentsTotal: integer("installments_total").notNull().default(1),
    // #406/#411: Efectiva Mensual Vencida (EM / MV) stored as percent × 10000
    // (so "1.9110%" → 19110). Preserves the 4-decimal precision Bancolombia
    // prints on real extracts. Null falls back to the bucket on
    // `accounts.metadata.creditRateBuckets` matching `installments_total` at
    // compute time (see #407). Validator rejects non-zero values < 5000
    // (< 0.5% EM), almost certainly EA mislabeled as EM.
    //
    // NOTE: DB column is still named `installment_rate_bps` (from #406's
    // original smallint scheme) to avoid a rename in #411's migration.
    // The stored unit CHANGED — it's now "percent × 10000", not bps.
    installmentRateEmX10k: integer("installment_rate_bps"),
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
    // Transfer group id (#405 / parent #345). When set, this tx is one leg of
    // a multi-leg transfer (e.g. TC statement payment = savings debit + TC
    // credit). App-level invariants: (a) every tx in the group has the same
    // user_id, (b) Σ(amount_cents) = 0, (c) soft-delete is atomic across the
    // group. Validated in tests / action layer, not the DB.
    transferGroupId: uuid("transfer_group_id"),
    rawData: jsonb("raw_data").notNull().default({}),
    notes: text("notes"),
    // #454 (Epic G): merchant extracted from a gateway email receipt
    // (MP/PayU/Wompi/Apple/PayPal). `description_raw` is preserved unchanged
    // for audit/rollback. Classification reads enriched_merchant first when
    // present.
    enrichedMerchant: varchar("enriched_merchant", { length: 200 }),
    // #454 (Epic G): which pipeline produced the enrichment. Currently only
    // 'gmail' — extensible for future sources (e.g. 'manual_correction').
    enrichmentSource: varchar("enrichment_source", { length: 40 }),
    // #517 (Epic ARQ): set when a gmail_arq email tx is merged with an ARQ
    // statement row. Stores the reconciling source label (e.g. 'arq_statement')
    // without mutating the primary `source` column (first-in wins).
    // Design decision: a separate nullable text column is safer than converting
    // `source` to a comma-separated string or JSON array — it keeps the enum
    // constraint on the primary source, avoids array parsing, and is trivially
    // queryable. See #517 implementer notes.
    secondarySource: varchar("secondary_source", { length: 40 }),
    // #517 (Epic ARQ): the externalId assigned by the statement parser
    // (arq-stmt-<hash>) for the matched statement line. Used for idempotency:
    // if this column is already set, re-running the reconciler skips the merge.
    externalIdStatement: varchar("external_id_statement", { length: 200 }),
    // #517 (Epic ARQ): FK to arq_statement_imports. Populated on both MERGE
    // (existing gmail_arq tx updated) and INSERT (new arq_statement tx). Null
    // means the tx pre-dates statement import or has not been reconciled yet.
    arqStatementImportId: integer("arq_statement_import_id").references(
      (): AnyPgColumn => arqStatementImports.id,
      { onDelete: "set null" },
    ),
    // #457 (Epic G): set by A+ dedup when SMS and Email Bancolombia describe
    // the same event with diverging fields. See SourceMismatchDetails type.
    sourceMismatch: boolean("source_mismatch").notNull().default(false),
    sourceMismatchDetails: jsonb("source_mismatch_details").$type<SourceMismatchDetails>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_account_occurred_idx").on(t.accountId, t.occurredAt),
    index("transactions_user_occurred_idx").on(t.userId, t.occurredAt),
    index("transactions_user_category_idx").on(t.userId, t.categorySlug),
    index("transactions_user_counterparty_idx").on(t.userId, t.counterpartyId),
    index("transactions_account_recon_idx").on(t.accountId, t.reconciliationStatus, t.occurredAt),
    index("transactions_transfer_group_idx")
      .on(t.transferGroupId)
      .where(sql`${t.transferGroupId} IS NOT NULL`),
    index("transactions_flagged_idx")
      .on(t.userId, t.occurredAt)
      .where(sql`${t.reconciliationStatus} = 'flagged'`),
    index("transactions_account_occurred_live_idx")
      .on(t.accountId, t.occurredAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index("transactions_user_occurred_live_idx")
      .on(t.userId, t.occurredAt)
      .where(sql`${t.deletedAt} IS NULL`),
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
    // #418: extracto_detallado consolidation tracks the cycle + the match
    // report + the synthetic intereses-causados tx for auditability and
    // idempotency. Null for movimientos imports.
    kind: statementImportKind("kind").notNull().default("movimientos"),
    cycle: varchar("cycle", { length: 7 }),
    syntheticTxId: integer("synthetic_tx_id"),
    report: jsonb("report"),
  },
  (t) => [
    uniqueIndex("statement_imports_user_account_file_unique").on(t.userId, t.accountId, t.fileHash),
    index("statement_imports_account_period_idx").on(t.accountId, t.periodStart, t.periodEnd),
    uniqueIndex("statement_imports_cycle_unique")
      .on(t.userId, t.accountId, t.cycle)
      .where(sql`${t.kind} = 'extracto_detallado' AND ${t.cycle} IS NOT NULL`),
  ],
);

// #436: cycles the user explicitly marked as "don't consolidate" — escape
// hatch from the "pending forever" nag for ciclos viejos sin extracto o
// ya cuadrados vía balance_adjustment. Soft-delete via `deletedAt` so
// unskipping preserves history. A `statement_imports` row for the same
// (user, account, cycle) always wins — the work is already done; a skip
// becomes redundant but does not block.
export const skippedConsolidationCycles = pgTable(
  "skipped_consolidation_cycles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    cycle: varchar("cycle", { length: 7 }).notNull(),
    reason: text("reason"),
    skippedAt: timestamp("skipped_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // At most one live skip per (user, account, cycle). Soft-deleted rows
    // don't count so skip → unskip → re-skip is legal.
    uniqueIndex("skipped_consolidation_cycles_live_unique")
      .on(t.userId, t.accountId, t.cycle)
      .where(sql`${t.deletedAt} IS NULL`),
    index("skipped_consolidation_cycles_user_account_idx")
      .on(t.userId, t.accountId)
      .where(sql`${t.deletedAt} IS NULL`),
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

// #633: amount_type enum for recurring_transactions — 'fixed' is the default
// (all existing rows). 'variable' is set by the learning loop when N consecutive
// observations show non-uniform real amounts (EPM-style subscriptions).
export const recurringAmountType = pgEnum("recurring_amount_type", ["fixed", "variable"]);

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
    // #633: amount type — 'fixed' (default, all existing rows) or 'variable'
    // (set by the learning loop when N consecutive observations show non-uniform
    // real amounts). When 'variable', amount proposals are suppressed.
    // amountType column references the enum defined just above recurringTransactions
    amountType: recurringAmountType("amount_type").notNull().default("fixed"),
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
    // #621: resolution tracking — set when a gap is closed via manual link,
    // promote, dismiss, or auto-link. NULL means the gap is still open.
    // Values: 'linked' | 'synthetic' | 'skipped' | 'auto-linked'
    resolution: varchar("resolution", { length: 20 }),
    resolutionTxId: integer("resolution_tx_id").references((): AnyPgColumn => transactions.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("recurring_gaps_recurring_month_unique").on(t.recurringId, t.yearMonth),
    index("recurring_gaps_detected_idx").on(t.detectedAt),
    index("recurring_gaps_user_detected_idx").on(t.userId, t.detectedAt),
    index("recurring_gaps_open_idx")
      .on(t.userId, t.detectedAt)
      .where(sql`${t.resolution} IS NULL`),
  ],
);

// #633: Learning loop — observation + fingerprint + proposal tables.
// Architecture invariant: transactions table = facts only. Observations and
// proposals are SEPARATE tables. The learning loop NEVER mutates transactions
// directly — only proposes changes the user accepts.

// #633: proposal status enum — 'pending' is the initial state, transitions to
// 'accepted' (user approved), 'rejected' (user dismissed), or 'expired' (cron
// cleaned up stale pending proposals).
export const recurringProposalStatus = pgEnum("recurring_proposal_status", [
  "pending",
  "accepted",
  "rejected",
  "expired",
]);

// #633: Append-only audit log for every tx ↔ recurring link event (manual + auto).
// Single observation per link — idempotent via unique (user_id, recurring_id, tx_id, year_month).
// applied=true once a proposal that references this observation is accepted.
export const recurringLinkObservations = pgTable(
  "recurring_link_observations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recurringId: integer("recurring_id")
      .notNull()
      .references(() => recurringTransactions.id, { onDelete: "cascade" }),
    txId: integer("tx_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    yearMonth: varchar("year_month", { length: 7 }).notNull(),
    realAmountCents: bigint("real_amount_cents", { mode: "bigint" }).notNull(),
    realCurrency: currency("real_currency").notNull(),
    descriptionRaw: text("description_raw"),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    manual: boolean("manual").notNull().default(false),
    applied: boolean("applied").notNull().default(false),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency: one observation per (user, recurring, tx, month).
    uniqueIndex("recurring_link_observations_unique").on(
      t.userId,
      t.recurringId,
      t.txId,
      t.yearMonth,
    ),
    // Cron query: manual, unapplied observations grouped by recurring.
    index("recurring_link_observations_pending_idx")
      .on(t.userId, t.recurringId)
      .where(sql`${t.manual} = true AND ${t.applied} = false`),
    index("recurring_link_observations_recurring_idx").on(t.recurringId),
  ],
);

// #633: Description fingerprint table — upserted after every link.
// observation_count is incremented each time the same pattern is observed.
// pattern_ambiguous=true when this pattern matches 2+ active recurrings for
// the same user (Google Play caveat) — excluded from auto-link via description.
export const recurringDescriptionPatterns = pgTable(
  "recurring_description_patterns",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recurringId: integer("recurring_id")
      .notNull()
      .references(() => recurringTransactions.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    observationCount: integer("observation_count").notNull().default(1),
    patternAmbiguous: boolean("pattern_ambiguous").notNull().default(false),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One pattern per (user, recurring, pattern text) — upsert key.
    uniqueIndex("recurring_description_patterns_unique").on(t.userId, t.recurringId, t.pattern),
    // Auto-link lookup: patterns for a given user + pattern text (cross-recurring).
    index("recurring_description_patterns_user_pattern_idx").on(t.userId, t.pattern),
    index("recurring_description_patterns_recurring_idx").on(t.recurringId),
  ],
);

// #633: Learning proposals — amount-update or variable-type change proposals
// generated by the recurring-learning cron. User accepts/rejects via
// /settings/recurring/learning. payload is typed by proposal_type:
//   - amount_update: { newAmountCents: string, oldAmountCents: string, currency: string }
//   - variable_flag:  { detectedAmounts: string[], currency: string }
export const recurringProposals = pgTable(
  "recurring_proposals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recurringId: integer("recurring_id")
      .notNull()
      .references(() => recurringTransactions.id, { onDelete: "cascade" }),
    proposalType: varchar("proposal_type", { length: 40 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: recurringProposalStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    // Cron query: pending proposals per user.
    index("recurring_proposals_user_status_idx")
      .on(t.userId, t.status)
      .where(sql`${t.status} = 'pending'`),
    index("recurring_proposals_recurring_idx").on(t.recurringId),
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
  | "awaiting_batch_confirm"
  | "awaiting_backfill_confirm"
  | "backfill_running"
  | "awaiting_disambiguation";

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
  // #405: when set, the confirm inserts with channel="transfer" and
  // category_slug=null. If `destinationAccountId` is also set, a companion
  // credit leg is inserted atomically as a transfer group (used for
  // tc_payment). Without destination, a single unpaired transfer leg is
  // inserted (used for tc_credit_received — origin is external).
  transfer?: {
    destinationAccountId?: number;
  };
};

// #458 — when `step` is `awaiting_backfill_confirm` or `backfill_running`,
// this block holds the requested window (ISO yyyy-mm-dd). `step` is the
// cancel signal the backfill loop polls — when the user hits /cancel the
// session row is deleted, and the loop sees `getSession() === null`.
export type TelegramBackfillState = {
  from: string;
  to: string;
  gateway: "bancolombia";
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
  backfill?: TelegramBackfillState;
  // #456 — when `step` is `awaiting_disambiguation`, these fields identify the
  // receipt being resolved and the candidate transaction ids.
  disambiguationReceiptId?: number;
  disambiguationCandidates?: number[];
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
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
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

// Per-SMS audit row for the AI fallback pipeline (#257) and the eventual
// /admin/slos dashboard (#329 — continuation of closed #249). Append-only.
// Today we only emit rows on the needs_review path (regex failed → maybe
// AI fallback); the dashboard issue later extends this to log all parse
// outcomes for SLO cards.
//
// `source` is the ingest channel (today just "sms"). `eventKind` is the
// lifecycle terminal state for this SMS — exactly one row per ingest
// attempt. `regex_outcome` is the serialized ParseResult; `ai_outcome`
// captures the AI response shape (+ error detail in the failure kinds).
export const PARSER_EVENT_KINDS = [
  "parse_outcome_success", // regex parser matched a known shape → ingest attempted
  "parse_outcome_skip", // SMS intentionally skipped (failed/non-transactional); NOT a failure
  "parse_needs_review", // regex failed, AI fallback not invoked (kill-switch / disabled)
  "ai_fallback_success", // AI parsed, confidence ≥ threshold → ingested
  "ai_fallback_low_confidence", // AI parsed, below threshold → inbox
  "ai_fallback_error", // AI timeout / API error / schema rejected
] as const;
export type ParserEventKind = (typeof PARSER_EVENT_KINDS)[number];

export const PARSER_EVENT_SOURCES = ["sms", "apple_pay", "other"] as const;
export type ParserEventSource = (typeof PARSER_EVENT_SOURCES)[number];

export const parserEvents = pgTable(
  "parser_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 20 }).$type<ParserEventSource>().notNull(),
    eventKind: varchar("event_kind", { length: 40 }).$type<ParserEventKind>().notNull(),
    regexOutcome: jsonb("regex_outcome").$type<Record<string, unknown>>(),
    aiOutcome: jsonb("ai_outcome").$type<Record<string, unknown>>(),
    aiConfidence: numeric("ai_confidence", { precision: 4, scale: 3 }),
    aiModel: varchar("ai_model", { length: 50 }),
    aiInputTokens: integer("ai_input_tokens"),
    aiOutputTokens: integer("ai_output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("parser_events_created_idx").on(t.createdAt),
    index("parser_events_kind_idx").on(t.eventKind, t.createdAt),
    // Partial index for dashboard drill-down: "show me recent AI fallback
    // outcomes" is the most common ad-hoc query and avoids scanning the
    // table once parse-outcome logging is also added in #329.
    index("parser_events_ai_fallback_idx")
      .on(t.createdAt)
      .where(sql`${t.eventKind} LIKE 'ai_fallback_%'`),
  ],
);

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

// Sustained-threshold alerts for the SLO dashboard (#329 PR3). Same dedup
// shape as canary_alerts: at most one unresolved row per sloKey at any time.
// Rate/target stored as 4-decimal numeric for auditability; raw rolls up from
// whatever sourced it (parser_events, transactions, etc).
export const sloAlerts = pgTable(
  "slo_alerts",
  {
    id: serial("id").primaryKey(),
    sloKey: varchar("slo_key", { length: 40 }).notNull(),
    rate: numeric("rate", { precision: 5, scale: 4 }).notNull(),
    target: numeric("target", { precision: 5, scale: 4 }).notNull(),
    samples: integer("samples").notNull(),
    notificationStatus: varchar("notification_status", { length: 40 }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("slo_alerts_open_idx")
      .on(t.sloKey, t.firedAt)
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
    // Sum of (derived_balance − latest statement_imports.balance_at_end_cents)
    // across accounts whose most recent 30d statement import carries a balance,
    // where `derived_balance = SUM(transactions.amount_cents)` per #368/#370 —
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

// #450 (Epic G): one row per (user, gmail account) connection. Tokens are
// AES-256-GCM encrypted via src/lib/crypto/symmetric.ts using
// GMAIL_TOKEN_ENCRYPTION_KEY (separate from the Telegram token key for
// blast-radius isolation). Soft-deleted on disconnect; the Google revoke
// call is best-effort.
export const gmailConnections = pgTable(
  "gmail_connections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailEmail: varchar("gmail_email", { length: 320 }).notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes").array().notNull(),
    // Watermarks for incremental pulls. `last_pull_history_id` is Gmail's
    // history cursor — when present, the next pull uses history.list for
    // delta sync; when absent (first pull or after a long gap that exceeded
    // history retention), falls back to messages.list with `after:` filter.
    lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
    lastPullHistoryId: text("last_pull_history_id"),
    status: gmailConnectionStatus("status").notNull().default("active"),
    statusReason: text("status_reason"),
    // #456 — tracks when the last Telegram re-auth nudge was sent so we can
    // throttle to at most once per 24h regardless of how many pull cycles run.
    botNudgeSentAt: timestamp("bot_nudge_sent_at", { withTimezone: true }),
    // #498 — per-connection bootstrap window. When lastPullAt is null (first
    // pull or after a reconnect), computeSinceDate uses this date instead of
    // the old 30-day rolling fallback. Application layer treats null as
    // Jan 1 of the current year.
    bootstrapSinceDate: timestamp("bootstrap_since_date", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Allow a user to reconnect the same gmail address after disconnecting
    // (soft-deleted rows are excluded from uniqueness).
    uniqueIndex("gmail_connections_user_email_unique")
      .on(t.userId, t.gmailEmail)
      .where(sql`${t.deletedAt} IS NULL`),
    index("gmail_connections_user_status_idx")
      .on(t.userId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    // Pull engine scans active connections — partial index keeps it tight.
    index("gmail_connections_active_idx")
      .on(t.lastPullAt)
      .where(sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL`),
  ],
);

// #450 (Epic G): one row per parsed Gmail message. Idempotency by
// `gmail_msg_id` ensures repeated pulls don't duplicate work. Raw HTML is
// preserved for audit and re-parsing if a parser bug is fixed later.
export const emailReceipts = pgTable(
  "email_receipts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailConnectionId: integer("gmail_connection_id")
      .notNull()
      .references(() => gmailConnections.id, { onDelete: "cascade" }),
    gmailMsgId: varchar("gmail_msg_id", { length: 64 }).notNull(),
    gateway: emailReceiptGateway("gateway").notNull(),
    // Populated after parsing. NULL while parse is pending or if the parser
    // returns `needs_review` (raw_html is kept regardless for retry).
    merchant: varchar("merchant", { length: 200 }),
    amountCents: bigint("amount_cents", { mode: "bigint" }),
    currency: currency("currency"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    referenceId: varchar("reference_id", { length: 120 }),
    rawHtml: text("raw_html").notNull(),
    parsedPayload: jsonb("parsed_payload").$type<ParsedReceiptPayload | Record<string, never>>(),
    matchedTransactionId: integer("matched_transaction_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "set null" },
    ),
    matchStatus: emailReceiptMatchStatus("match_status").notNull().default("pending"),
    // When match_status='ambiguous': array of candidate tx_ids. The user
    // disambiguates via /transactions UI (#455) or Telegram bot (#456).
    matchCandidates: jsonb("match_candidates").$type<number[]>(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    // Gmail's `internalDate` for the message — the moment Gmail received it,
    // which for ARQ/PayPal/MP notification emails is essentially the moment
    // of the underlying transaction. Persisted at pull time so the parser
    // step uses the real email timestamp instead of `createdAt` (which is
    // when the cron created the row, not when the email arrived). Nullable
    // for backfill compatibility — receipts ingested before this column was
    // added stay NULL until a backfill script populates them.
    emailReceivedAt: timestamp("email_received_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency: same Gmail message can never be ingested twice for the
    // same user. Soft-deleted rows excluded so a user can re-import after
    // archive (rare).
    uniqueIndex("email_receipts_user_msg_unique")
      .on(t.userId, t.gmailMsgId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Pull engine + matcher hot path: find pending/ambiguous receipts for
    // a user.
    index("email_receipts_user_status_idx")
      .on(t.userId, t.matchStatus)
      .where(sql`${t.deletedAt} IS NULL`),
    // Matcher join target: scan candidate receipts by user + amount + time
    // window. Partial on non-bancolombia (gateway enrichments) since
    // bancolombia uses a different ingestion path.
    index("email_receipts_match_lookup_idx")
      .on(t.userId, t.amountCents, t.occurredAt)
      .where(sql`${t.matchStatus} = 'pending' AND ${t.deletedAt} IS NULL`),
    index("email_receipts_connection_idx").on(t.gmailConnectionId),
    // #455 (Epic G): GIN index on match_candidates for fast JSONB containment
    // queries used by the disambiguation loader. Partial: only ambiguous rows
    // carry a non-null candidates array, so this index stays small.
    index("email_receipts_candidates_gin_idx")
      .using("gin", t.matchCandidates)
      .where(sql`${t.matchStatus} = 'ambiguous' AND ${t.deletedAt} IS NULL`),
  ],
);

// #471 — Per-user snapshots of transactional data. Payload is a JSON dump of
// every user-owned table that gets wiped by the reset flow (#472). Config
// tables (accounts, categories, rules, budgets, tokens, etc.) are NOT
// snapshotted — they survive reset and therefore survive restore too.
//
// schemaVersion pins the drizzle migration tag active at save time; a restore
// against a different schema is rejected rather than risking partial column
// mismatches. Cross-migration restore is out of scope for MVP.
export const userSnapshots = pgTable(
  "user_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull(),
    payloadBytes: bigint("payload_bytes", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_snapshots_user_created_idx").on(t.userId, t.createdAt.desc())],
);

// #515 (Epic ARQ sub-issue C): audit + idempotency table for ARQ statement
// imports. One row per processed statement; written after parse + reconcile.
//
// Tenant safety: always filter by BOTH user_id AND account_id when querying.
// JOINing on account_id alone can produce cross-tenant leaks — the accounts
// table does NOT enforce a global unique constraint on id independently of
// user ownership. Every query that touches this table must include
//   WHERE arq_statement_imports.user_id = $userId
// in addition to any account_id predicate.
//
// No soft-delete: this is an audit table. Re-importing the same PDF is
// detected via raw_pdf_hash (idempotency check in runStatementImport). If an
// import row must be superseded (manual correction), insert a new row for the
// same (user_id, account_id, period_start) — the UNIQUE constraint will reject
// duplicates, which is intentional: force explicit cleanup before re-import.
// #518 (Epic ARQ Phase 4): extensible registry of fiat on/off-ramp partners
// used by ARQ to disburse COP to Colombian bank accounts. When ARQ disperses
// via PEXTO COLOMBIA, the Bancolombia leg arrives as a credit from PEXTO
// rather than from the user themselves. This table allows the transfer pairer
// to recognise PEXTO-initiated credits as self-transfers rather than external
// income — without hard-coding the partner name in application logic.
//
// No soft-delete: partners are either active=true (considered for pairing) or
// active=false (ignored). Deactivation is manual DB edit + reload; no UI in scope.
export const fiatPartners = pgTable(
  "fiat_partners",
  {
    id: serial("id").primaryKey(),
    // 'arq', 'wise', etc. — discriminates partners by the off-ramp system that
    // generates them so a single query can filter by source_system without
    // touching unrelated rows.
    sourceSystem: varchar("source_system", { length: 40 }).notNull(),
    // The counterparty name exactly as it appears in the Bancolombia notification
    // (SMS or email). Comparison is case-insensitive ILIKE in the pairer.
    partnerName: varchar("partner_name", { length: 200 }).notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("fiat_partners_system_name_unique").on(t.sourceSystem, t.partnerName),
    index("fiat_partners_source_active_idx")
      .on(t.sourceSystem)
      .where(sql`${t.active} = true`),
  ],
);

// #518 (Epic ARQ Phase 4): name variants for a user used by the cross-currency
// transfer pairer. ARQ emails include a `recipient_name` field (e.g.
// "Alejandro Rafael Martinez Maldonado", "Alejandro Martinez") that must be
// matched against `users.name` or an alias to confirm the transfer was a
// self-transfer and not a payment to a third party.
//
// Tenant safety: every query MUST scope alias lookup to the same user_id as the
// candidate transfer — never join on alias alone (memory per-user-table-join-tenant-safety).
export const userAliases = pgTable(
  "user_aliases",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The alias text as it appears in the source (e.g. "Alejandro Martinez").
    // Stored as-is; comparison in the pairer uses case-insensitive normalisation.
    alias: varchar("alias", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_aliases_user_alias_unique").on(t.userId, t.alias),
    index("user_aliases_user_idx").on(t.userId),
  ],
);

export const arqStatementImports = pgTable(
  "arq_statement_imports",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** Opening balance declared in the PDF header, in USDc cents. */
    declaredStartCents: bigint("declared_start_cents", { mode: "bigint" }).notNull(),
    /** Closing balance declared in the PDF header, in USDc cents. */
    declaredEndCents: bigint("declared_end_cents", { mode: "bigint" }).notNull(),
    /** Number of parsed (non-skip) transactions in this statement. */
    parsedCount: integer("parsed_count").notNull(),
    /** Net signed sum of parsed transactions in USDc cents (credits − debits). */
    parsedSumCents: bigint("parsed_sum_cents", { mode: "bigint" }).notNull(),
    /** True when |calcEnd − declaredEnd| ≤ 1 cent. False means import was aborted. */
    reconciled: boolean("reconciled").notNull(),
    /** Signed cents difference (calcEnd − declaredEnd). Null when reconciled=true. */
    reconcileDiffCents: bigint("reconcile_diff_cents", { mode: "bigint" }),
    /**
     * Inter-month chain check result. Null on the first imported statement for
     * this (user_id, account_id). False is a soft warn (gap or correction) —
     * it does NOT abort the import.
     */
    chainOk: boolean("chain_ok"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    /** SHA-256 hex hash of the raw PDF bytes — used for idempotent re-import detection. */
    rawPdfHash: varchar("raw_pdf_hash", { length: 64 }).notNull(),
  },
  (t) => [
    // One row per (user, account, period). Re-importing requires explicit
    // cleanup. Paired user_id + account_id enforces tenant safety at the DB level.
    uniqueIndex("arq_statement_imports_period_unique").on(t.userId, t.accountId, t.periodStart),
    // Fast idempotency lookup by PDF hash (scoped to user for tenant safety).
    uniqueIndex("arq_statement_imports_user_hash_unique").on(t.userId, t.rawPdfHash),
    // Used by the inter-month chain check: find the most-recent prior statement.
    index("arq_statement_imports_account_period_idx").on(t.userId, t.accountId, t.periodEnd),
  ],
);
