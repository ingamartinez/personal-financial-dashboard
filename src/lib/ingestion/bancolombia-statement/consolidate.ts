import { createHash } from "node:crypto";

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { db, type DB } from "@/lib/db";
import {
  accounts,
  categories,
  physicalCards,
  statementImports,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { applyInteresesCausadosForCycle } from "@/lib/finance/intereses-causados-job";
import { createLogger } from "@/lib/logger";
import { convertCents } from "@/lib/money";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { withCanonical } from "@/lib/insights/merchant-canonical";

// #433 — the balance_adjustment plug goes into the user's Ajustes de saldo
// category (same one the reconcile flow + opening-balance tx use). We always
// call ensureAdjustmentsCategory before insert so this never FK-fails on
// accounts whose category was soft-deleted by the user.
const ADJUSTMENTS_CATEGORY_SLUG = "adjustments";

import {
  isBankInterestRow,
  matchStatementAgainstLedger,
  merchantSimilarity,
  statementAmountToLedger,
  type MatchResult,
  type TxRowForMatch,
} from "./match";
import type { ParsedStatement, StatementRow } from "./types";

const log = createLogger({ module: "bancolombia-statement-consolidate" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CYCLE_REGEX = /^\d{4}-\d{2}$/;

export type ConsolidationStatus = "dry-run" | "consolidated" | "already-consolidated" | "no-op";

export type InteresesOutcome =
  | {
      status: "inserted";
      txId: number;
      totalInterestCentsStr: string;
      purchasesNeedingRate: number;
    }
  | { status: "skipped"; reason: string; purchasesNeedingRate: number }
  | { status: "not-run"; reason: "dry-run" | "already-consolidated" };

export type MatchStats = {
  matched: number;
  matchedWillChange: number;
  insertedMissing: number;
  skippedMissingBefore: number;
  unmatchedInLedger: number;
  // #555 — how many COP-twin txs were reassigned to this (USD) account
  // because the USD statement matched them via merchantSimilarity + date window.
  // Zero on accounts without a physicalCardId sibling.
  crossTwinReassigned: number;
};

// #432 — projection of how the account's saldo disponible will change when
// this cycle is consolidated. Computed once BEFORE any ledger mutation so the
// snapshot reflects the pre-commit state. All cent values are serialized as
// strings to keep ConsolidationReport JSON-safe.
//
// Ledger-sign convention throughout: for a credit card, compras are negative
// and pagos positive. `deltaCentsStr` + `saldoActualCentsStr` = projected.
export type BalanceProjection = {
  saldoActualCentsStr: string;
  saldoProyectadoCentsStr: string;
  deltaCentsStr: string;
  breakdown: {
    // Sum of missing-during-period rows that will be INSERTed (excludes
    // synthetic bank-interest rows and auth-less rows we skip).
    comprasNuevasCentsStr: string;
    // Null when intereses haven't been run yet (dry-run); positive-or-zero
    // ledger-signed value once inserted.
    interesesCentsStr: string | null;
    // Informational — sum of existing balance_adjustment plugs on this
    // account with occurredAt ≤ cycle.endDate. These are NOT auto-retired
    // (see epic #435 non-goals); capa 3 (#434) handles cleanup.
    plugsObsoletosCentsStr: string;
    // #433 — the compensator plug inserted by this consolidation to reconcile
    // the ledger against a user-provided "saldo real". Null when no input was
    // provided OR when the ledger already matched exactly (no plug needed).
    balanceAdjustmentPlugCentsStr: string | null;
  };
  warn: {
    // |delta| threshold above which the UI paints a warning.
    thresholdCentsStr: string;
    exceeded: boolean;
  };
  // #443 — client-facing credit-limit info so consolidate-form can render a
  // positive "Cupo disponible (según tu banco)" input for credit_card accounts
  // and derive the ledger-signed value locally before submitting. Absent/null
  // on savings & loans (client keeps the legacy ledger-signed input for those).
  creditContext?: CreditContext | null;
};

// #443 — credit-limit context surfaced to the client. For single-currency TCs
// we only need the limit. For shared-cupo multi-currency TCs (MC/Amex
// internacional) we also need the siblings' current debt in COP and the TRM
// so the client can back-solve the target sub-account's ledger value using
// the same math as `BalanceAdjustDialog::SharedCupoForm`.
export type CreditContext =
  | { kind: "single-currency"; creditLimitCentsStr: string }
  | {
      kind: "shared-cupo";
      creditLimitCopCentsStr: string;
      siblingDebtCopCentsStr: string;
      copPerUsd: number;
    };

// #433 — info about a balance_adjustment tx inserted to reconcile the ledger
// against a user-provided "saldo real". Null at the report level when no
// input was provided or ledger already matched.
export type BalanceAdjustmentPlug = {
  txId: number;
  amountCentsStr: string; // ledger-signed plug value
  userInputCentsStr: string; // the saldo real the user typed (ledger sign)
};

export type ConsolidationReport = {
  userId: number;
  accountId: number;
  // Account currency — useful to callers rendering multi-sheet previews so they
  // can label each report section (COP vs USD) without re-querying the account.
  currency: "COP" | "USD";
  cycle: string;
  dryRun: boolean;
  status: ConsolidationStatus;
  matchStats: MatchStats;
  matchedTxIds: number[];
  insertedTxIds: number[];
  // Row-level diffs for UI preview (B3). Serialized bigints as strings.
  matchedDiffs: Array<{
    txId: number;
    willChange: boolean;
    merchant: string;
    occurredAt: string;
    amountCentsStr: string;
    installmentsTotalBefore: number;
    installmentsTotalAfter: number;
    rateEmX10kBefore: number | null;
    rateEmX10kAfter: number | null;
  }>;
  missingInLedger: Array<{
    merchant: string;
    occurredAt: string;
    amountCentsStr: string;
    kind: "during-period" | "before-period";
    authorizationNumber: string | null;
  }>;
  unmatchedInLedgerIds: number[];
  statementImportId: number | null;
  intereses: InteresesOutcome;
  // #432 — may be absent on legacy persisted reports (pre-#432). UI must
  // treat `undefined` as "not available" and omit the section.
  projection?: BalanceProjection;
  // #433 — plug tx info when `saldoRealLedgerCents` was provided on commit.
  // Null when input was absent OR no plug was needed (already-matching).
  balanceAdjustment?: BalanceAdjustmentPlug | null;
};

export type ConsolidateOptions = {
  userId: number;
  accountId: number;
  cycle: string;
  parsed: ParsedStatement;
  fileHash: string;
  dryRun: boolean;
  database?: DB;
  // #433 — optional user input "saldo real" in the account currency's ledger
  // sign (negative for TC debt, positive for savings). When provided AND
  // dryRun=false AND status ends up "consolidated", inserts a
  // balance_adjustment tx post-intereses so the final ledger SUM matches
  // this value exactly.
  saldoRealLedgerCents?: bigint | null;
  // #760 — when true, bypass the already-consolidated guard and upsert the
  // existing statement_imports row instead of inserting a new one. Useful
  // when the user wants to re-import a corrected extracto.
  force?: boolean;
};

export function hashStatementBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// Bancolombia uses "000000" as a placeholder authorizationNumber for synthetic
// bank operations (refinanciación, AMPLIACION DE PLAZO, ABONO AMPLIACION, etc.)
// where no real merchant authorization was issued. Multiple such rows can appear
// in the same cycle with inverse amounts — they must each get a unique externalId
// so the onConflictDoNothing dedup in insertMissingRowInTx doesn't collapse the
// second row into silence.
//
// For real auth codes (non-000000) we keep the auth-only key for dedup stability
// (already in prod). For placeholder rows we extend the key with a normalized
// merchant slug + amount so the pair (AMPLIACION/+4M) and (ABONO/-4M) never
// share an externalId. The merchant slug is lowercased and stripped of
// non-alphanumeric chars so minor extracto formatting differences don't produce
// phantom duplicates across cycles.
const PLACEHOLDER_AUTH = "000000";

function normalizeMerchantSlug(merchant: string): string {
  return merchant
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function externalIdFor(
  accountId: number,
  cycle: string,
  authCode: string,
  row: { merchant: string; amountCents: bigint },
): string {
  if (authCode === PLACEHOLDER_AUTH) {
    const slug = normalizeMerchantSlug(row.merchant);
    // Include the ledger-sign amount so AMPLIACION (+4M → ledger -4M) and
    // ABONO (-4M → ledger +4M) produce distinct keys even on the same date.
    const amount = row.amountCents.toString();
    return `bancolombia-stmt:${accountId}:${cycle}:${authCode}:${slug}:${amount}`;
  }
  return `bancolombia-stmt:${accountId}:${cycle}:${authCode}`;
}

// Before-period installment purchases get a cycle-agnostic key so the same
// purchase isn't inserted twice when multiple cycles are consolidated in
// sequence (ENE→FEB→MAR: ALKOMPRAR MOLINOS appears before-period in all
// three but should only enter the ledger once).
//
// The key omits `cycle` and uses a `before` namespace so it never collides
// with the during-period keys above. Placeholder auth rows include the
// normalized merchant slug + statement-sign amount to disambiguate pairs.
function externalIdForBeforePeriod(
  accountId: number,
  authCode: string,
  row: { merchant: string; amountCents: bigint },
): string {
  if (authCode === PLACEHOLDER_AUTH) {
    const slug = normalizeMerchantSlug(row.merchant);
    const amount = row.amountCents.toString();
    return `bancolombia-stmt:${accountId}:before:${authCode}:${slug}:${amount}`;
  }
  return `bancolombia-stmt:${accountId}:before:${authCode}`;
}

// Returns true for before-period statement rows that should be inserted into
// the ledger so the intereses-causados job can price them. Criteria:
//   1. Multi-cuota (installments.total > 1) — 1-cuota purchases never accrue
//      interest so inserting them doesn't help the job.
//   2. Has a rate — the job needs it to compute interest. A row without a rate
//      would become needsRate (interestCents=0), contributing nothing.
//   3. Positive extracto amount — that's a purchase (expense). Negative rows
//      are credits/abonos; inserting them as installment purchases would be wrong.
//   4. Has a real authorizationNumber — required for a stable externalId.
function isInsertableBeforePeriodRow(row: StatementRow): boolean {
  if (row.authorizationNumber === null) return false;
  if (row.amountCents <= BigInt(0)) return false;
  if (row.installments === null || row.installments.total <= 1) return false;
  if (row.rateEmX10k === null) return false;
  return true;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, delta: number): Date {
  return new Date(d.getTime() + delta * MS_PER_DAY);
}

function minRowDate(parsed: ParsedStatement): Date | null {
  if (parsed.rows.length === 0) return null;
  let min = parsed.rows[0].occurredAt;
  for (const row of parsed.rows) {
    if (row.occurredAt.getTime() < min.getTime()) min = row.occurredAt;
  }
  return min;
}

async function loadAccount(
  database: DB,
  userId: number,
  accountId: number,
): Promise<{
  id: number;
  currency: "COP" | "USD";
  physicalCardId: string | null;
  type: "savings" | "credit_card" | "loan";
}> {
  const [row] = await database
    .select({
      id: accounts.id,
      currency: accounts.currency,
      physicalCardId: accounts.physicalCardId,
      type: accounts.type,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `consolidateCycleFromStatement: account ${accountId} not found for user ${userId}`,
    );
  }
  return row;
}

// #555 — if the account being consolidated has a physicalCardId, find the
// sibling account (same physicalCardId, same user, different currency, not
// soft-deleted). Returns null when no sibling exists (single-currency TC or no
// physicalCardId). Used by the cross-twin reconciliation pass.
async function loadSiblingTwinAccount(
  database: DB,
  userId: number,
  physicalCardId: string,
  excludeAccountId: number,
): Promise<{ id: number; currency: "COP" | "USD" } | null> {
  const [row] = await database
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.physicalCardId, physicalCardId),
        sql`${accounts.id} != ${excludeAccountId}`,
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// #555 — shape of sibling twin txs fetched for cross-twin candidate matching.
// We only load txs with sources that a gmail/sms parser would have created —
// never csv_reconcile (those are already statement-sourced, no need to move them).
export type SiblingTxForCrossTwin = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  merchant: string | null;
  descriptionRaw: string;
};

async function loadSiblingTxsForCrossTwin(
  database: DB,
  userId: number,
  siblingAccountId: number,
  fromDate: Date,
  toDate: Date,
): Promise<SiblingTxForCrossTwin[]> {
  return database
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, siblingAccountId),
        gte(transactions.occurredAt, fromDate),
        lte(transactions.occurredAt, toDate),
        notDeleted(transactions.deletedAt),
        sql`${transactions.source} IN ('gmail_bancolombia', 'sms')`,
      ),
    );
}

// #432 — inputs for BalanceProjection. Split out so tests can unit-feed the
// math helper without a live DB.
type ProjectionInputs = {
  saldoActualCents: bigint;
  plugsObsoletosCents: bigint;
  // Null when the account has no physical_card link AND no inline
  // metadata.creditLimitCents — threshold falls back to the currency floor.
  // Always in COP cents for multi-currency cards (physical_cards.credit_limit_cents
  // is COP-denominated); callers pass `null` for USD sub-accounts where the
  // shared COP cupo wouldn't convert cleanly to the account currency.
  creditLimitCents: bigint | null;
  // #443 — in-memory twin of the output `CreditContext`. Bigints kept native
  // so builders don't have to re-parse. Null when the account isn't a credit
  // card OR is a TC without a configured limit (UI falls back to ledger-sign).
  creditContext: ProjectionCreditContext | null;
};

type ProjectionCreditContext =
  | { kind: "single-currency"; creditLimitCents: bigint }
  | {
      kind: "shared-cupo";
      creditLimitCopCents: bigint;
      siblingDebtCopCents: bigint;
      copPerUsd: number;
    };

async function loadProjectionInputs(
  database: DB,
  userId: number,
  accountId: number,
  currency: "COP" | "USD",
  cycleEndDate: Date,
): Promise<ProjectionInputs> {
  // Saldo actual via the correlated subquery helper.
  const [balanceRow] = await database
    .select({ cents: derivedBalanceCentsSql })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .limit(1);

  // Sum of existing balance_adjustment plugs with occurredAt ≤ cycle.endDate,
  // live only. These are the candidates for cleanup (capa 3 / #434).
  const [plugsRow] = await database
    .select({
      cents: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "balance_adjustment"),
        lte(transactions.occurredAt, cycleEndDate),
        notDeleted(transactions.deletedAt),
      ),
    );

  // Account + optional physical-card join. Used BOTH for the COP 15%-floor
  // threshold (creditLimitCents) and for the client-facing creditContext
  // (single-currency vs shared-cupo). We always load this — even for USD
  // sub-accounts — so the shared-cupo context is populated on both sides.
  const [accountRow] = await database
    .select({
      type: accounts.type,
      metadata: accounts.metadata,
      physicalCardId: accounts.physicalCardId,
      pcCredit: physicalCards.creditLimitCents,
    })
    .from(accounts)
    .leftJoin(
      physicalCards,
      and(eq(physicalCards.id, accounts.physicalCardId), eq(physicalCards.userId, accounts.userId)),
    )
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .limit(1);

  // Credit limit lookup for the COP 15%-floor warn threshold: physical_card
  // wins when linked (shared-cupo MC/Amex), else fall back to
  // metadata.creditLimitCents for single-currency TCs. For USD sub-accounts
  // we deliberately skip the physical_card COP cupo since 15%-of-COP-cupo
  // wouldn't map to USD cleanly — use floor only there.
  let creditLimitCents: bigint | null = null;
  if (currency === "COP") {
    if (accountRow?.pcCredit !== null && accountRow?.pcCredit !== undefined) {
      creditLimitCents = accountRow.pcCredit;
    } else if (accountRow?.metadata?.creditLimitCents) {
      creditLimitCents = BigInt(accountRow.metadata.creditLimitCents);
    }
  }

  // #443 — creditContext payload for the client. Only populated for credit
  // cards with a known limit. Shared-cupo (multi-currency) branch needs
  // siblings' live debt in COP + current TRM so the client can back-solve
  // the target sub-account's ledger value.
  let creditContext: ProjectionCreditContext | null = null;
  if (accountRow?.type === "credit_card") {
    const pcLimit = accountRow.pcCredit ?? null;
    const metaLimit = accountRow.metadata?.creditLimitCents;
    if (accountRow.physicalCardId && pcLimit !== null && pcLimit > BigInt(0)) {
      const siblingRows = await database
        .select({
          id: accounts.id,
          currency: accounts.currency,
          balanceCents: derivedBalanceCentsSql,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.physicalCardId, accountRow.physicalCardId),
            sql`${accounts.id} != ${accountId}`,
            notDeleted(accounts.deletedAt),
          ),
        );
      const fx = await getCurrentFxRate(database);
      let siblingDebtCopCents = BigInt(0);
      for (const sib of siblingRows) {
        const bal = BigInt(sib.balanceCents);
        const nativeDebt = bal < BigInt(0) ? -bal : BigInt(0);
        siblingDebtCopCents += convertCents(nativeDebt, sib.currency, "COP", fx.rate);
      }
      creditContext = {
        kind: "shared-cupo",
        creditLimitCopCents: pcLimit,
        siblingDebtCopCents,
        copPerUsd: fx.rate,
      };
    } else if (metaLimit !== undefined && metaLimit > 0) {
      creditContext = {
        kind: "single-currency",
        creditLimitCents: BigInt(metaLimit),
      };
    }
  }

  return {
    saldoActualCents: BigInt(balanceRow?.cents ?? "0"),
    plugsObsoletosCents: BigInt(plugsRow?.cents ?? "0"),
    creditLimitCents,
    creditContext,
  };
}

// COP floor: 500k COP cents; USD floor: 125 USD cents. Both chosen to match
// the issue's "propongo $500k COP" and a sensible USD equivalent. For COP we
// also compare against 15% of the credit limit; USD gets floor-only (see note
// in loadProjectionInputs).
const COP_THRESHOLD_FLOOR_CENTS = BigInt(500_000_00);
const USD_THRESHOLD_FLOOR_CENTS = BigInt(125_00);

function computeWarnThresholdCents(
  currency: "COP" | "USD",
  creditLimitCents: bigint | null,
): bigint {
  const floor = currency === "COP" ? COP_THRESHOLD_FLOOR_CENTS : USD_THRESHOLD_FLOOR_CENTS;
  if (currency === "COP" && creditLimitCents !== null) {
    // 15% = 15/100 — BigInt division truncates, fine for a threshold.
    const fifteenPct = (creditLimitCents * BigInt(15)) / BigInt(100);
    return fifteenPct > floor ? fifteenPct : floor;
  }
  return floor;
}

function absBigInt(x: bigint): bigint {
  return x < BigInt(0) ? -x : x;
}

// #432 — builds the final BalanceProjection from pre-loaded inputs plus the
// match result and (optionally) the intereses total in statement sign.
// Export for tests; callers inside this module build it via the wrapper below.
export function buildBalanceProjection(
  inputs: ProjectionInputs,
  match: MatchResult,
  currency: "COP" | "USD",
  interesesTotalCentsPositive: bigint | null,
  balanceAdjustmentPlugCents: bigint | null = null,
): BalanceProjection {
  // Compras insertables: during-period, real auth, not synthetic bank-interest.
  // Mirrors the filter in insertMissingRowInTx so the breakdown matches what
  // actually lands in the ledger.
  const extractoComprasCents = match.missingInLedger
    .filter((r) => r.kind === "during-period")
    .filter((r) => !isBankInterestRow(r))
    .filter((r) => r.authorizationNumber !== null)
    .reduce<bigint>((acc, r) => acc + r.amountCents, BigInt(0));
  const comprasNuevasCents = statementAmountToLedger(extractoComprasCents);

  const interesesLedgerCents =
    interesesTotalCentsPositive === null ? null : -interesesTotalCentsPositive;

  const deltaCents =
    comprasNuevasCents +
    (interesesLedgerCents ?? BigInt(0)) +
    (balanceAdjustmentPlugCents ?? BigInt(0));
  const saldoProyectadoCents = inputs.saldoActualCents + deltaCents;
  const thresholdCents = computeWarnThresholdCents(currency, inputs.creditLimitCents);
  const exceeded = absBigInt(deltaCents) > thresholdCents;

  return {
    saldoActualCentsStr: inputs.saldoActualCents.toString(),
    saldoProyectadoCentsStr: saldoProyectadoCents.toString(),
    deltaCentsStr: deltaCents.toString(),
    breakdown: {
      comprasNuevasCentsStr: comprasNuevasCents.toString(),
      interesesCentsStr: interesesLedgerCents === null ? null : interesesLedgerCents.toString(),
      plugsObsoletosCentsStr: inputs.plugsObsoletosCents.toString(),
      balanceAdjustmentPlugCentsStr:
        balanceAdjustmentPlugCents === null ? null : balanceAdjustmentPlugCents.toString(),
    },
    warn: {
      thresholdCentsStr: thresholdCents.toString(),
      exceeded,
    },
    creditContext: serializeCreditContext(inputs.creditContext),
  };
}

function serializeCreditContext(ctx: ProjectionCreditContext | null): CreditContext | null {
  if (ctx === null) return null;
  if (ctx.kind === "single-currency") {
    return {
      kind: "single-currency",
      creditLimitCentsStr: ctx.creditLimitCents.toString(),
    };
  }
  return {
    kind: "shared-cupo",
    creditLimitCopCentsStr: ctx.creditLimitCopCents.toString(),
    siblingDebtCopCentsStr: ctx.siblingDebtCopCents.toString(),
    copPerUsd: ctx.copPerUsd,
  };
}

// #433 — idempotent category upsert. Matches the reconcile-flow convention
// (same slug, name, icon, color) so plugs inserted here live in the same
// bucket as manual balance-adjustments from `/reconcile`.
async function ensureAdjustmentsCategory(database: DB, userId: number): Promise<void> {
  await database
    .insert(categories)
    .values({
      userId,
      slug: ADJUSTMENTS_CATEGORY_SLUG,
      name: "Ajustes de saldo",
      icon: "wrench",
      color: "#475569",
      sortOrder: 1000,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.slug] });
  // Un-archive if the user had soft-deleted the category previously.
  await database
    .update(categories)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(categories.userId, userId), eq(categories.slug, ADJUSTMENTS_CATEGORY_SLUG)));
}

type PlugInsertArgs = {
  userId: number;
  accountId: number;
  currency: "COP" | "USD";
  cycle: string;
  cycleEndDate: Date;
  statementImportId: number;
  saldoRealLedgerCents: bigint;
};

// #433 — after the main consolidation txn + intereses job have committed, if
// the user gave a saldo real we insert a single balance_adjustment tx for
// the delta so the ledger SUM matches the user's input exactly. No-op when
// the delta is zero. Runs OUTSIDE the consolidation transaction on purpose
// (intereses job is already outside — see its comment — and keeping the plug
// outside too means a failed insert doesn't roll back the ledger fix).
async function insertSaldoRealPlug(
  database: DB,
  args: PlugInsertArgs,
): Promise<BalanceAdjustmentPlug | null> {
  const [balanceRow] = await database
    .select({ cents: derivedBalanceCentsSql })
    .from(accounts)
    .where(and(eq(accounts.userId, args.userId), eq(accounts.id, args.accountId)))
    .limit(1);
  const ledgerSumCents = BigInt(balanceRow?.cents ?? "0");
  const plugCents = args.saldoRealLedgerCents - ledgerSumCents;
  if (plugCents === BigInt(0)) return null;

  await ensureAdjustmentsCategory(database, args.userId);
  const [inserted] = await database
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt: args.cycleEndDate,
      amountCents: plugCents,
      currency: args.currency,
      descriptionRaw: `Ajuste post-consolidación ${args.cycle} · saldo ingresado por user`,
      ...withCanonical("Balance adjustment"),
      categorySlug: ADJUSTMENTS_CATEGORY_SLUG,
      classificationMethod: "manual",
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
      statementImportId: args.statementImportId,
      rawData: {
        event: "saldo_real_consolidation_plug",
        issue: 433,
        cycle: args.cycle,
        declaredLedgerCents: args.saldoRealLedgerCents.toString(),
        previousLedgerCents: ledgerSumCents.toString(),
        statementImportId: args.statementImportId,
      },
    })
    .returning({ id: transactions.id });

  return {
    txId: inserted.id,
    amountCentsStr: plugCents.toString(),
    userInputCentsStr: args.saldoRealLedgerCents.toString(),
  };
}

async function loadExistingTxs(
  database: DB,
  userId: number,
  accountId: number,
  fromDate: Date,
  toDate: Date,
): Promise<TxRowForMatch[]> {
  const rows = await database
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      installmentsTotal: transactions.installmentsTotal,
      installmentRateEmX10k: transactions.installmentRateEmX10k,
      externalId: transactions.externalId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        gte(transactions.occurredAt, fromDate),
        lte(transactions.occurredAt, toDate),
        notDeleted(transactions.deletedAt),
      ),
    );
  return rows;
}

function buildMatchStats(
  match: MatchResult,
  insertedBeforePeriodCount = 0,
  crossTwinReassigned = 0,
): MatchStats {
  const matchedWillChange = match.matched.filter((m) => m.willChange).length;
  // `insertedMissing` counts during-period inserts + before-period installment
  // inserts (added in #557) so the UI "Nuevas" stat reflects everything landed.
  // Cross-twin reassigned rows are NOT counted here — they are moves, not inserts.
  const insertedMissing =
    match.missingInLedger.filter((r) => r.kind === "during-period").length -
    crossTwinReassigned +
    insertedBeforePeriodCount;
  // `skippedMissingBefore` = before-period rows that did NOT qualify for insert
  // (1-cuota, missing rate, credit/abono, or no authCode).
  const skippedMissingBefore =
    match.missingInLedger.filter((r) => r.kind === "before-period").length -
    insertedBeforePeriodCount;
  return {
    matched: match.matched.length,
    matchedWillChange,
    insertedMissing,
    skippedMissingBefore,
    unmatchedInLedger: match.unmatchedInLedger.length,
    crossTwinReassigned,
  };
}

function serializeMatchedDiffs(match: MatchResult): ConsolidationReport["matchedDiffs"] {
  return match.matched.map((m) => ({
    txId: m.txId,
    willChange: m.willChange,
    merchant: m.statementRow.merchant,
    occurredAt: m.statementRow.occurredAt.toISOString(),
    amountCentsStr: m.statementRow.amountCents.toString(),
    installmentsTotalBefore: m.diff.installmentsTotalBefore,
    installmentsTotalAfter: m.diff.installmentsTotalAfter,
    rateEmX10kBefore: m.diff.rateEmX10kBefore,
    rateEmX10kAfter: m.diff.rateEmX10kAfter,
  }));
}

function serializeMissing(match: MatchResult): ConsolidationReport["missingInLedger"] {
  return match.missingInLedger.map((r) => ({
    merchant: r.merchant,
    occurredAt: r.occurredAt.toISOString(),
    amountCentsStr: r.amountCents.toString(),
    kind: r.kind,
    authorizationNumber: r.authorizationNumber,
  }));
}

function emptyReport(
  opts: ConsolidateOptions,
  account: { id: number; currency: "COP" | "USD" },
  match: MatchResult,
  status: ConsolidationStatus,
  statementImportId: number | null,
  intereses: InteresesOutcome,
  projection: BalanceProjection,
): ConsolidationReport {
  return {
    userId: opts.userId,
    accountId: opts.accountId,
    currency: account.currency,
    cycle: opts.cycle,
    dryRun: opts.dryRun,
    status,
    matchStats: buildMatchStats(match),
    matchedTxIds: match.matched.map((m) => m.txId),
    insertedTxIds: [],
    matchedDiffs: serializeMatchedDiffs(match),
    missingInLedger: serializeMissing(match),
    unmatchedInLedgerIds: match.unmatchedInLedger.map((t) => t.id),
    statementImportId,
    intereses,
    projection,
    balanceAdjustment: null,
  };
}

export async function consolidateCycleFromStatement(
  opts: ConsolidateOptions,
): Promise<ConsolidationReport> {
  if (!CYCLE_REGEX.test(opts.cycle)) {
    throw new Error(`consolidateCycleFromStatement: cycle must be YYYY-MM, got "${opts.cycle}"`);
  }
  const database = opts.database ?? db;
  const account = await loadAccount(database, opts.userId, opts.accountId);

  // Short-circuit if this cycle is already consolidated. Return the persisted
  // report so callers can display past runs without re-work.
  // #760: when force=true, skip this guard and proceed to upsert the row.
  const [existing] = await database
    .select({
      id: statementImports.id,
      report: statementImports.report,
      syntheticTxId: statementImports.syntheticTxId,
    })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.userId, opts.userId),
        eq(statementImports.accountId, opts.accountId),
        eq(statementImports.kind, "extracto_detallado"),
        eq(statementImports.cycle, opts.cycle),
      ),
    )
    .limit(1);
  if (existing && !opts.force) {
    const persistedReport = (existing.report ?? {}) as Partial<ConsolidationReport>;
    return {
      ...(persistedReport as ConsolidationReport),
      // Persisted reports written before the currency field was added may
      // lack it — fill from the current account so the UI has what it needs.
      currency: persistedReport.currency ?? account.currency,
      dryRun: opts.dryRun,
      status: "already-consolidated",
      statementImportId: existing.id,
      intereses: {
        status: "not-run",
        reason: "already-consolidated",
      },
    };
  }

  const earliest = minRowDate(opts.parsed);
  // #555: cross-twin window is ±3 Bogota days — wider than the same-account
  // window (±1 day) because the email is ingested in real-time with a slight
  // timezone skew vs. the statement's calendar date. The same fromDate/toDate
  // expansion is re-used for both the same-account and cross-twin tx loads.
  const CROSS_TWIN_DAYS = 3;
  const fromDate = earliest
    ? addDays(earliest, -CROSS_TWIN_DAYS)
    : addDays(opts.parsed.period.startDate, -CROSS_TWIN_DAYS);
  const toDate = addDays(opts.parsed.period.endDate, CROSS_TWIN_DAYS);
  const txs = await loadExistingTxs(database, opts.userId, opts.accountId, fromDate, toDate);
  // #763 — credit cards: SMS is captured at authorization time (real clock),
  // but the statement's value-date can lag 1–3 days. Widen the date window so
  // a ±1-day default doesn't cause a no-match → duplicate-insert.
  const matchTolerance = account.type === "credit_card" ? 3 : 1;
  const match = matchStatementAgainstLedger(opts.parsed, txs, {
    dateToleranceDays: matchTolerance,
  });

  // #555 — load sibling twin account + its ledger txs for cross-twin pass.
  // Both are null when the account has no physicalCardId (single-currency TC).
  const siblingAccount =
    account.physicalCardId !== null
      ? await loadSiblingTwinAccount(database, opts.userId, account.physicalCardId, opts.accountId)
      : null;
  const siblingTxs: SiblingTxForCrossTwin[] =
    siblingAccount !== null
      ? await loadSiblingTxsForCrossTwin(database, opts.userId, siblingAccount.id, fromDate, toDate)
      : [];

  // #432 — snapshot saldo + plugs BEFORE any mutation so the projection
  // reflects the pre-commit state in both dry-run and commit paths.
  const projectionInputs = await loadProjectionInputs(
    database,
    opts.userId,
    opts.accountId,
    account.currency,
    opts.parsed.period.endDate,
  );

  if (opts.dryRun) {
    const dryProjection = buildBalanceProjection(projectionInputs, match, account.currency, null);
    return emptyReport(
      opts,
      account,
      match,
      "dry-run",
      null,
      { status: "not-run", reason: "dry-run" },
      dryProjection,
    );
  }

  const nothingToDo =
    match.matched.every((m) => !m.willChange) &&
    match.missingInLedger.every((r) => r.kind !== "during-period");
  if (nothingToDo) {
    // Still persist a statement_imports row so the cycle is marked "seen" —
    // but we skip the intereses run because nothing changed ledger-side, and
    // we return "no-op" so callers can distinguish "applied" vs "nothing to
    // apply". The intereses-causados-job is still idempotent on its own
    // cycleKey check if called later.
    //
    // Run the intereses job anyway so the first-ever consolidation of a
    // cycle produces the synthetic; the job is a no-op when the synthetic
    // already exists (cycleKey idempotency).
  }

  // Part 1: ledger UPDATEs + INSERTs + statement_imports row in a single
  // transaction. applyInteresesCausadosForCycle runs AFTER commit — it owns
  // its own idempotency (cycleKey) so a second run is a no-op, and keeping it
  // outside this tx avoids the drizzle DB-vs-Transaction type mismatch and
  // makes partial-failure semantics sane (ledger fix commits even if the
  // intereses job fails; user can retry).
  const {
    imp,
    matchedIdsToUpdate,
    insertedTxIds,
    insertedBeforePeriodCount,
    crossTwinReassignedIds,
  } = await database.transaction(async (txDb) => {
    // #760 — when force=true and a previous row already exists, UPDATE it in
    // place (upsert) so we never accumulate duplicate rows per (user, account,
    // cycle). The unique constraint is on (userId, accountId, kind, cycle).
    let imp: { id: number };
    if (opts.force && existing) {
      await txDb
        .update(statementImports)
        .set({
          fileHash: opts.fileHash,
          periodStart: toIsoDate(opts.parsed.period.startDate),
          periodEnd: toIsoDate(opts.parsed.period.endDate),
          txnCount: 0, // will be updated at end of tx
          balanceAtEndCents: opts.parsed.summary.currentBalanceCents,
          report: null,
          importedAt: new Date(),
        })
        .where(eq(statementImports.id, existing.id));
      imp = { id: existing.id };
    } else {
      const [inserted] = await txDb
        .insert(statementImports)
        .values({
          userId: opts.userId,
          accountId: opts.accountId,
          fileHash: opts.fileHash,
          periodStart: toIsoDate(opts.parsed.period.startDate),
          periodEnd: toIsoDate(opts.parsed.period.endDate),
          txnCount: 0,
          kind: "extracto_detallado",
          cycle: opts.cycle,
          // #563 — persist the cycle-end balance from the extracto summary so
          // the snapshot backfill (#562) can use it as an opening-balance anchor.
          // currentBalanceCents = "Pago total" = what the bank says you owe.
          balanceAtEndCents: opts.parsed.summary.currentBalanceCents,
          report: null,
        })
        .returning({ id: statementImports.id });
      imp = inserted;
    }

    const matchedIdsToUpdate: number[] = [];
    for (const m of match.matched) {
      if (!m.willChange) continue;
      await txDb
        .update(transactions)
        .set({
          installmentsTotal: m.diff.installmentsTotalAfter,
          ...(m.diff.rateEmX10kAfter !== null && {
            installmentRateEmX10k: m.diff.rateEmX10kAfter,
          }),
          reconciliationStatus: "matched",
          reconciledAt: new Date(),
          statementImportId: imp.id,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, m.txId), eq(transactions.userId, opts.userId)));
      matchedIdsToUpdate.push(m.txId);
    }

    // #555 — cross-twin reconciliation pass.
    // For each during-period row that is missing from this account's ledger,
    // look in the sibling twin (COP) account for a gmail_bancolombia/sms tx
    // that matches on merchant similarity + date proximity. When found, move
    // the tx to this (USD) account with the statement amount/currency, marking
    // source_mismatch so the divergence is auditable.
    //
    // This runs AFTER the same-account match loop so that txs already matched
    // within the same account are never considered for cross-twin.
    //
    // Security: every query in this block is scoped by opts.userId — the
    // sibling query (loadSiblingTwinAccount) also filters by userId, so a
    // different user's physicalCardId would never be reachable.
    const crossTwinReassignedIds: number[] = [];
    const crossTwinReassignedRowIndices = new Set<number>();
    const CROSS_TWIN_SIMILARITY_THRESHOLD = 0.3;
    const CROSS_TWIN_DATE_TOLERANCE_DAYS = 3;

    if (siblingAccount !== null && siblingTxs.length > 0) {
      // Build a mutable pool of sibling candidates so each tx is picked at
      // most once (prevents double-reassignment if two statement rows happen
      // to match the same sibling tx).
      const siblingPool = new Map<number, SiblingTxForCrossTwin>(siblingTxs.map((t) => [t.id, t]));

      for (let rowIdx = 0; rowIdx < match.missingInLedger.length; rowIdx++) {
        const row = match.missingInLedger[rowIdx];
        if (row.kind !== "during-period") continue;
        if (isBankInterestRow(row)) continue;
        if (row.authorizationNumber === null) continue;

        // The statement row uses extracto sign (compra = positive). We want
        // to find a sibling tx that represents the same expenditure regardless
        // of the amount — the COP tx and the USD statement row will have
        // completely different magnitudes, so we do NOT filter by amount.
        // We rely solely on merchant similarity + date proximity.
        const candidates = Array.from(siblingPool.values()).filter((sibling) => {
          const dateDelta = Math.abs(
            Math.floor(
              (sibling.occurredAt.getTime() - 5 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000),
            ) - Math.floor((row.occurredAt.getTime() - 5 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000)),
          );
          if (dateDelta > CROSS_TWIN_DATE_TOLERANCE_DAYS) return false;
          const label = sibling.merchant ?? sibling.descriptionRaw;
          return merchantSimilarity(row.merchant, label) > CROSS_TWIN_SIMILARITY_THRESHOLD;
        });

        if (candidates.length === 0) continue;

        // Among candidates, pick by: smallest date delta → highest merchant
        // similarity → smallest tx id (same tiebreak as pickBestCandidate in
        // match.ts, adapted for SiblingTxForCrossTwin shape).
        const best = candidates
          .map((sibling) => {
            const label = sibling.merchant ?? sibling.descriptionRaw;
            return {
              sibling,
              dateDelta: Math.abs(
                Math.floor(
                  (sibling.occurredAt.getTime() - 5 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000),
                ) -
                  Math.floor(
                    (row.occurredAt.getTime() - 5 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000),
                  ),
              ),
              similarity: merchantSimilarity(row.merchant, label),
            };
          })
          .sort((a, b) => {
            if (a.dateDelta !== b.dateDelta) return a.dateDelta - b.dateDelta;
            if (a.similarity !== b.similarity) return b.similarity - a.similarity;
            return a.sibling.id - b.sibling.id;
          })[0].sibling;

        siblingPool.delete(best.id);

        const originalAmountCents = best.amountCents;
        const originalCurrency = best.currency;
        const originalAccountId = siblingAccount.id;
        const newAmountCents = statementAmountToLedger(row.amountCents);
        const impliedTrm =
          row.amountCents > BigInt(0) && newAmountCents !== BigInt(0)
            ? (
                Number(
                  originalAmountCents < BigInt(0) ? -originalAmountCents : originalAmountCents,
                ) / Number(newAmountCents < BigInt(0) ? -newAmountCents : newAmountCents)
              ).toFixed(2)
            : null;

        await txDb
          .update(transactions)
          .set({
            accountId: opts.accountId,
            currency: account.currency,
            amountCents: newAmountCents,
            reconciliationStatus: "matched",
            reconciledAt: new Date(),
            statementImportId: imp.id,
            sourceMismatch: true,
            sourceMismatchDetails: {
              fromSource: "gmail_bancolombia",
              toSource: "csv_reconcile",
              diffs: [
                {
                  field: "accountId",
                  fromValue: String(originalAccountId),
                  toValue: String(opts.accountId),
                },
                {
                  field: "amountCents",
                  fromValue: originalAmountCents.toString(),
                  toValue: newAmountCents.toString(),
                },
                {
                  field: "currency",
                  fromValue: originalCurrency,
                  toValue: account.currency,
                },
                {
                  field: "impliedTrm",
                  fromValue: null,
                  toValue: impliedTrm,
                },
              ],
            },
            updatedAt: new Date(),
          })
          // Tenant-safety: must match BOTH id AND userId — never rely on id alone.
          .where(and(eq(transactions.id, best.id), eq(transactions.userId, opts.userId)));

        crossTwinReassignedIds.push(best.id);
        crossTwinReassignedRowIndices.add(rowIdx);

        log.info(
          {
            userId: opts.userId,
            accountId: opts.accountId,
            cycle: opts.cycle,
            siblingAccountId: originalAccountId,
            txId: best.id,
            merchant: row.merchant,
            originalAmountCents: originalAmountCents.toString(),
            newAmountCents: newAmountCents.toString(),
            originalCurrency,
            newCurrency: account.currency,
            impliedTrm,
            event: "cross_twin_reassigned",
          },
          "consolidate: cross-twin reassignment — moved tx from COP sibling to USD account",
        );
      }
    }

    const insertedTxIds: number[] = [];
    let insertedBeforePeriodCount = 0;
    for (let rowIdx = 0; rowIdx < match.missingInLedger.length; rowIdx++) {
      const row = match.missingInLedger[rowIdx];
      // #555 — skip rows already handled by the cross-twin pass above.
      if (crossTwinReassignedRowIndices.has(rowIdx)) continue;

      if (row.kind === "before-period") {
        // #557: insert missing before-period multi-cuota purchases so the
        // intereses-causados job can price them in the current cycle.
        // Non-qualifying rows (credits, 1-cuota, missing rate, no authCode)
        // are skipped silently — they are either not installment purchases or
        // already have no interest potential.
        if (!isInsertableBeforePeriodRow(row)) continue;
        const inserted = await insertMissingBeforePeriodRowInTx(txDb, {
          opts,
          account,
          row,
          statementImportId: imp.id,
        });
        if (inserted !== null) {
          insertedTxIds.push(inserted);
          insertedBeforePeriodCount += 1;
          log.info(
            {
              accountId: opts.accountId,
              cycle: opts.cycle,
              merchant: row.merchant,
              installmentsTotal: row.installments?.total,
              rateEmX10k: row.rateEmX10k,
              txId: inserted,
              event: "before_period_installment_inserted",
            },
            "consolidate: inserted missing before-period installment purchase",
          );
        }
        continue;
      }
      // during-period
      if (isBankInterestRow(row)) continue;
      if (row.authorizationNumber === null) {
        log.warn(
          {
            accountId: opts.accountId,
            cycle: opts.cycle,
            merchant: row.merchant,
            event: "missing_auth_skip",
          },
          "consolidate: skipping missing row without authorizationNumber",
        );
        continue;
      }
      const inserted = await insertMissingRowInTx(txDb, {
        opts,
        account,
        row,
        statementImportId: imp.id,
      });
      if (inserted !== null) insertedTxIds.push(inserted);
    }

    await txDb
      .update(statementImports)
      .set({
        txnCount: matchedIdsToUpdate.length + insertedTxIds.length + crossTwinReassignedIds.length,
      })
      .where(eq(statementImports.id, imp.id));

    return {
      imp,
      matchedIdsToUpdate,
      insertedTxIds,
      insertedBeforePeriodCount,
      crossTwinReassignedIds,
    };
  });

  const interesesResult = await applyInteresesCausadosForCycle({
    userId: opts.userId,
    accountId: opts.accountId,
    cycle: opts.cycle,
    database,
  });
  const intereses: InteresesOutcome = interesesToOutcome(interesesResult);

  const interesesTotalCents =
    intereses.status === "inserted" ? BigInt(intereses.totalInterestCentsStr) : BigInt(0);

  // #433 — optional plug to reconcile ledger SUM against a user-provided
  // saldo real. Runs AFTER intereses so the plug balances the final state.
  // `null` when no input was given OR when the ledger already matched
  // (plug insert would have been zero).
  let balanceAdjustment: BalanceAdjustmentPlug | null = null;
  if (opts.saldoRealLedgerCents != null) {
    balanceAdjustment = await insertSaldoRealPlug(database, {
      userId: opts.userId,
      accountId: opts.accountId,
      currency: account.currency,
      cycle: opts.cycle,
      cycleEndDate: opts.parsed.period.endDate,
      statementImportId: imp.id,
      saldoRealLedgerCents: opts.saldoRealLedgerCents,
    });
    log.info(
      {
        userId: opts.userId,
        accountId: opts.accountId,
        cycle: opts.cycle,
        saldoRealLedgerCents: opts.saldoRealLedgerCents.toString(),
        plugInserted: balanceAdjustment !== null,
        plugTxId: balanceAdjustment?.txId ?? null,
        event: "saldo_real_plug",
      },
      balanceAdjustment
        ? "consolidate: inserted saldo-real compensator plug"
        : "consolidate: saldo-real matched ledger, no plug needed",
    );
  }

  // #432 — projection pins `saldoActualCents` to the pre-commit snapshot so
  // delta = what *this consolidation* moved (compras + intereses + optional
  // plug). Intereses + plug are filled in here since both run AFTER the main
  // txn commits.
  const projection = buildBalanceProjection(
    projectionInputs,
    match,
    account.currency,
    interesesTotalCents,
    balanceAdjustment === null ? null : BigInt(balanceAdjustment.amountCentsStr),
  );

  const finalReport: ConsolidationReport = {
    userId: opts.userId,
    accountId: opts.accountId,
    currency: account.currency,
    cycle: opts.cycle,
    dryRun: false,
    status: "consolidated",
    matchStats: buildMatchStats(match, insertedBeforePeriodCount, crossTwinReassignedIds.length),
    matchedTxIds: matchedIdsToUpdate,
    insertedTxIds,
    matchedDiffs: serializeMatchedDiffs(match),
    missingInLedger: serializeMissing(match),
    unmatchedInLedgerIds: match.unmatchedInLedger.map((t) => t.id),
    statementImportId: imp.id,
    intereses,
    projection,
    balanceAdjustment,
  };

  await database
    .update(statementImports)
    .set({
      report: finalReport,
      ...(intereses.status === "inserted" && { syntheticTxId: intereses.txId }),
    })
    .where(eq(statementImports.id, imp.id));

  return finalReport;
}

type InsertMissingArgs = {
  opts: ConsolidateOptions;
  account: { id: number; currency: "COP" | "USD" };
  row: StatementRow;
  statementImportId: number;
};

// Named *InTx because it must run inside a transaction handle — caller passes
// the drizzle tx object, not the top-level db.
async function insertMissingRowInTx(
  txDb: Parameters<Parameters<DB["transaction"]>[0]>[0],
  { opts, account, row, statementImportId }: InsertMissingArgs,
): Promise<number | null> {
  const external = externalIdFor(opts.accountId, opts.cycle, row.authorizationNumber!, row);
  const result = await txDb
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: account.id,
      occurredAt: row.occurredAt,
      // statement row uses extracto sign convention (compra+, abono-) while
      // the ledger stores the opposite — invert on the way in.
      amountCents: statementAmountToLedger(row.amountCents),
      currency: account.currency,
      descriptionRaw: row.merchant,
      ...withCanonical(row.merchant),
      installmentsTotal: row.installments?.total ?? 1,
      installmentRateEmX10k: row.rateEmX10k,
      source: "csv_reconcile",
      channel: "bank",
      reconciliationStatus: "imported_from_statement",
      reconciledAt: new Date(),
      statementImportId,
      externalId: external,
      rawData: {
        statementKind: "extracto_detallado",
        cycle: opts.cycle,
        authorizationNumber: row.authorizationNumber,
        saldoPendingCents: row.saldoPendingCents.toString(),
        installmentValueCents: row.installmentValueCents?.toString() ?? null,
      },
    })
    .onConflictDoNothing({
      target: [transactions.accountId, transactions.externalId],
      where: sql`${transactions.externalId} IS NOT NULL`,
    })
    .returning({ id: transactions.id });
  return result[0]?.id ?? null;
}

// #557: insert a before-period installment purchase that was missing from the
// ledger. Uses a cycle-agnostic externalId (`before` namespace) so the same
// row isn't inserted twice when multiple consecutive cycles are consolidated.
// The `onConflictDoNothing` on (accountId, externalId) is the guard.
async function insertMissingBeforePeriodRowInTx(
  txDb: Parameters<Parameters<DB["transaction"]>[0]>[0],
  { opts, account, row, statementImportId }: InsertMissingArgs,
): Promise<number | null> {
  const external = externalIdForBeforePeriod(opts.accountId, row.authorizationNumber!, row);
  const result = await txDb
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: account.id,
      occurredAt: row.occurredAt,
      amountCents: statementAmountToLedger(row.amountCents),
      currency: account.currency,
      descriptionRaw: row.merchant,
      ...withCanonical(row.merchant),
      installmentsTotal: row.installments!.total,
      installmentRateEmX10k: row.rateEmX10k,
      source: "csv_reconcile",
      channel: "bank",
      reconciliationStatus: "imported_from_statement",
      reconciledAt: new Date(),
      statementImportId,
      externalId: external,
      rawData: {
        statementKind: "extracto_detallado",
        // `importedFromBeforePeriod` flags that the purchase date pre-dates
        // the cycle being consolidated — useful for audit trails.
        importedFromBeforePeriod: true,
        cycle: opts.cycle,
        authorizationNumber: row.authorizationNumber,
        saldoPendingCents: row.saldoPendingCents.toString(),
        installmentValueCents: row.installmentValueCents?.toString() ?? null,
        installmentsPaid: row.installments!.paid,
        installmentsTotal: row.installments!.total,
      },
    })
    .onConflictDoNothing({
      target: [transactions.accountId, transactions.externalId],
      where: sql`${transactions.externalId} IS NOT NULL`,
    })
    .returning({ id: transactions.id });
  return result[0]?.id ?? null;
}

function interesesToOutcome(
  r: Awaited<ReturnType<typeof applyInteresesCausadosForCycle>>,
): InteresesOutcome {
  if (r.status === "inserted") {
    return {
      status: "inserted",
      txId: r.txId,
      totalInterestCentsStr: r.totalInterestCents.toString(),
      purchasesNeedingRate: r.purchasesNeedingRate,
    };
  }
  if (r.status === "skipped") {
    return {
      status: "skipped",
      reason: r.reason,
      purchasesNeedingRate: r.purchasesNeedingRate,
    };
  }
  return {
    status: "skipped",
    reason: `error:${r.reason}`,
    purchasesNeedingRate: 0,
  };
}
