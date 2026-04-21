/**
 * Widget handler: `mis-tcs` — aggregate credit-card roster for the authed user.
 *
 * Returns every live credit card the user owns, regardless of card shape:
 *
 * - Multi-currency TCs (one `physical_cards` row with 2+ linked `accounts`)
 *   collapse to a SINGLE entry keyed on `physical_cards.id`. Cupo and
 *   USD→COP conversion are handled via `getAvailableCreditCOP` using the
 *   current TRM. Display fields come from the `physical_cards` row.
 *
 * - Single-currency TCs (`accounts.physical_card_id IS NULL` AND
 *   `type='credit_card'`) return as one entry per account, keyed on
 *   `accounts.id`. Cupo lives on `accounts.metadata.creditLimitCents`, balance
 *   comes from `derivedBalanceCentsSql` (negative = debt).
 *
 * Output is always ordered by `utilization_pct DESC` — most-stressed cards
 * float to the top so the widget leads with the cards that most need attention.
 *
 * Size rules (issue #386):
 * - `S` → 422 invalid_params (too cramped to show a roster).
 * - `M` → top 3 cards after sort.
 * - `L` → all cards.
 *
 * Empty-roster case (user has no TCs) returns 200 with `cards: []` and both
 * totals at 0. This is NOT an error — a new user naturally has zero cards.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { notDeleted } from "@/lib/db/helpers";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { toCop } from "@/lib/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";
import type { WidgetHandler, WidgetHandlerResult } from "@/app/api/widget/v1/[id]/registry";
import { bogotaIsoNow, centsToCop, roundUtilizationPct } from "./_shared";

// Kept for parity with tc-focus: the handler is NOT the final logger call
// site (DB helpers log themselves), but a fail-soft branch below wants a
// structured warn. Do not remove even if temporarily unused.
const log = createLogger({ module: "widget-mis-tcs" });

const BI_ZERO = BigInt(0);

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type MisTcsCard = {
  // `string` for multi-currency (UUID from physical_cards), `number` for
  // single-currency (serial from accounts). The contract keeps them in the
  // same field — Scriptable treats both as opaque.
  id: string | number;
  name: string;
  network: string | null;
  last4: string | null;
  available_cop: number;
  credit_limit_cop: number;
  utilization_pct: number;
};

type MisTcsData = {
  cards: MisTcsCard[];
  total_available_cop: number;
  total_credit_cop: number;
};

type MisTcsResponse = {
  widget_id: "mis-tcs";
  size: "M" | "L";
  data: MisTcsData;
  generated_at: string;
};

type MisTcsErrorCode = "invalid_params";

type MisTcsErrorBody = { error: { code: MisTcsErrorCode; message: string } };

const STATUS_BY_CODE: Record<MisTcsErrorCode, number> = {
  invalid_params: 422,
};

function errorResult(code: MisTcsErrorCode, message: string): WidgetHandlerResult {
  const body: MisTcsErrorBody = { error: { code, message } };
  return { body, status: STATUS_BY_CODE[code] };
}

// ---------------------------------------------------------------------------
// Internal row types produced by the two DB queries. We keep them flat and
// bigint-typed so the merge step does no runtime coercion gymnastics.
// ---------------------------------------------------------------------------

type MultiCurrencyRow = {
  id: string;
  name: string | null;
  institution: string;
  network: string | null;
  last4: string | null;
  creditLimitCents: bigint;
  // sum(COP balances) — negative when the card carries debt.
  copDebtCents: bigint;
  // sum(USD balances) — negative when the card carries debt, in USD cents.
  usdDebtCents: bigint;
};

type SingleCurrencyRow = {
  id: number;
  name: string;
  institution: string;
  currency: "COP" | "USD";
  metadata: AccountMetadata;
  balanceCents: bigint;
};

// ---------------------------------------------------------------------------
// Queries — two round-trips for the whole roster, not N+1. Multi-currency
// cards aggregate COP/USD sub-account balances inline (same approach as
// `getAvailableCreditCOP` but for ALL of the user's physical cards in one
// shot). Single-currency cards are a plain scan of `accounts`.
// ---------------------------------------------------------------------------

async function fetchMultiCurrencyCards(userId: number): Promise<MultiCurrencyRow[]> {
  const rows = await db
    .select({
      id: physicalCards.id,
      name: physicalCards.name,
      institution: physicalCards.institution,
      network: physicalCards.network,
      last4: physicalCards.last4,
      creditLimitCents: physicalCards.creditLimitCents,
      copDebtCents: sql<string>`
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'COP' THEN ${derivedBalanceCentsSql} ELSE 0 END), 0)
      `,
      usdDebtCents: sql<string>`
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'USD' THEN ${derivedBalanceCentsSql} ELSE 0 END), 0)
      `,
    })
    .from(physicalCards)
    .leftJoin(
      accounts,
      and(
        eq(accounts.physicalCardId, physicalCards.id),
        // Tenancy guard on the JOIN (memory #336, #338): per-user table
        // joins MUST pair user_id in the ON clause, never rely on the FK
        // alone. Also drop archived sub-accounts so their debt doesn't
        // linger in the available-credit calc.
        eq(accounts.userId, physicalCards.userId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .where(eq(physicalCards.userId, userId))
    .groupBy(
      physicalCards.id,
      physicalCards.name,
      physicalCards.institution,
      physicalCards.network,
      physicalCards.last4,
      physicalCards.creditLimitCents,
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    network: r.network,
    last4: r.last4,
    creditLimitCents: r.creditLimitCents,
    copDebtCents: BigInt(r.copDebtCents),
    usdDebtCents: BigInt(r.usdDebtCents),
  }));
}

async function fetchSingleCurrencyCards(userId: number): Promise<SingleCurrencyRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      currency: accounts.currency,
      metadata: accounts.metadata,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.type, "credit_card"),
        // Absence of physicalCardId is what distinguishes "plain" credit
        // cards from multi-currency sub-accounts. `isNull` + explicit
        // `notDeleted` also short-circuits the partial index we maintain
        // on live rows.
        isNull(accounts.physicalCardId),
        notDeleted(accounts.deletedAt),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    currency: r.currency as "COP" | "USD",
    metadata: (r.metadata ?? {}) as AccountMetadata,
    balanceCents: BigInt(r.balanceCents),
  }));
}

// ---------------------------------------------------------------------------
// Projections — bigint-math-first. Each branch computes `used` + `available`
// in COP cents, then delegates the display fields to the shared helpers.
// ---------------------------------------------------------------------------

function projectMultiCurrency(row: MultiCurrencyRow, copPerUsd: number): MisTcsCard {
  // Mirrors getAvailableCreditCOP() so the two paths can't drift:
  //   available = credit_limit + sum(COP bal) + sum(USD bal) * rate
  // Both bal sums are negative when the card has debt.
  const usdDebtInCop = toCop(row.usdDebtCents, "USD", copPerUsd);
  const availableCents = row.creditLimitCents + row.copDebtCents + usdDebtInCop;
  const usedCents = row.creditLimitCents - availableCents;
  const usedClamped = usedCents < BI_ZERO ? BI_ZERO : usedCents;
  const availableClamped = availableCents < BI_ZERO ? BI_ZERO : availableCents;

  // Display name fallback chain: physical_cards.name → "<institution> *last4"
  // → generic Spanish label. Matches tc-focus so users see the same string
  // in the tile and in the roster.
  const name =
    row.name?.trim() ||
    [row.institution, row.last4 ? `*${row.last4}` : null].filter(Boolean).join(" ") ||
    "Tarjeta de crédito";

  return {
    id: row.id,
    name,
    network: row.network,
    last4: row.last4,
    available_cop: centsToCop(availableClamped),
    credit_limit_cop: centsToCop(row.creditLimitCents),
    utilization_pct: roundUtilizationPct(usedClamped, row.creditLimitCents),
  };
}

function projectSingleCurrency(row: SingleCurrencyRow, copPerUsd: number): MisTcsCard {
  const limitNativeCents = BigInt(row.metadata.creditLimitCents ?? 0);
  // Credit-card balances are stored as negative debt; absolute value = used.
  const usedNativeCents = row.balanceCents < BI_ZERO ? -row.balanceCents : BI_ZERO;
  const availableNativeCents =
    limitNativeCents - usedNativeCents < BI_ZERO ? BI_ZERO : limitNativeCents - usedNativeCents;

  // The widget contract is COP-only. For a USD-denominated single-currency
  // card (rare but legal) we convert limit + available at the current TRM.
  // We deliberately skip used_cop — the contract doesn't expose it, and
  // utilization stays exact on native cents (ratio is invariant under a
  // positive-rate scaling).
  const limitCopCents = toCop(limitNativeCents, row.currency, copPerUsd);
  const availableCopCents = toCop(availableNativeCents, row.currency, copPerUsd);

  const last4 = row.metadata.last4s?.[0] ?? null;
  const network = row.metadata.network ?? null;

  const name = formatAccountLabel({
    name: row.name,
    currency: row.currency,
    institution: row.institution,
    metadata: { last4s: row.metadata.last4s ?? null },
  });

  return {
    id: row.id,
    name,
    network,
    last4,
    available_cop: centsToCop(availableCopCents),
    credit_limit_cop: centsToCop(limitCopCents),
    // Utilization on native cents (ratio is invariant under scaling by a
    // positive rate, so skipping the conversion keeps things exact).
    utilization_pct: roundUtilizationPct(usedNativeCents, limitNativeCents),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const misTcsHandler: WidgetHandler = async (ctx) => {
  if (ctx.size === "S") {
    return errorResult("invalid_params", "mis-tcs does not support size S");
  }

  const [multi, single] = await Promise.all([
    fetchMultiCurrencyCards(ctx.userId),
    fetchSingleCurrencyCards(ctx.userId),
  ]);

  // Only fetch FX when at least one card will actually need it. Saves a
  // round-trip for COP-only users (the common case today).
  const needsFx =
    multi.some((m) => m.usdDebtCents !== BI_ZERO) || single.some((s) => s.currency === "USD");
  const fxRate = needsFx ? (await getCurrentFxRate()).rate : 0;

  if (needsFx && fxRate <= 0) {
    // Should be impossible — getCurrentFxRate() falls back to a constant.
    // Log once and continue with 0 so at least COP lines still render.
    log.warn(
      { event: "mis_tcs_fx_nonpositive", userId: ctx.userId, fxRate },
      "mis-tcs got a non-positive fx rate",
    );
  }

  const cards: MisTcsCard[] = [
    ...multi.map((r) => projectMultiCurrency(r, fxRate)),
    ...single.map((r) => projectSingleCurrency(r, fxRate)),
  ];

  // Sort by utilization DESC. Tiebreak on available_cop ASC so the card with
  // less headroom wins when two sit at the same percentage — still lines up
  // with "most-stressed first".
  cards.sort((a, b) => {
    if (b.utilization_pct !== a.utilization_pct) {
      return b.utilization_pct - a.utilization_pct;
    }
    return a.available_cop - b.available_cop;
  });

  const trimmed = ctx.size === "M" ? cards.slice(0, 3) : cards;

  // Totals are computed over the FULL roster (pre-trim). A `size=M` response
  // still advertises the user's real total cupo, otherwise the tile would
  // silently understate headroom whenever the user has more than 3 cards.
  let totalAvailable = 0;
  let totalCredit = 0;
  for (const c of cards) {
    totalAvailable += c.available_cop;
    totalCredit += c.credit_limit_cop;
  }

  const body: MisTcsResponse = {
    widget_id: "mis-tcs",
    size: ctx.size,
    data: {
      cards: trimmed,
      total_available_cop: totalAvailable,
      total_credit_cop: totalCredit,
    },
    generated_at: bogotaIsoNow(new Date()),
  };
  return { body };
};
