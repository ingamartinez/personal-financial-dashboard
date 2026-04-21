/**
 * Widget handler: `recent-tx` — most recent transactions for the authed user (#389).
 *
 * Feed tile: last 3 (`size=M`) or last 5 (`size=L`) live transactions. Unlike
 * `hoy` / `mes-actual`, this is a RECENT-ACTIVITY feed — the user wants to see
 * everything that happened on their accounts, not just "gasto". So the
 * exclusions are intentionally shorter:
 *
 *   - Soft-deleted rows (`notDeleted`) drop out — archived txs aren't activity.
 *   - Balance adjustments drop out (both `source = 'balance_adjustment'` AND
 *     `is_adjustment = true`). These are reconciliation artifacts, not real
 *     financial events; surfacing them in a feed would confuse the user.
 *
 * What stays IN (differs from the spend-centric widgets):
 *   - Transfers (`channel = 'transfer'`) — paying a credit card is real activity.
 *   - Credits / refunds (positive `amount_cents`) — the sign is preserved in
 *     `amount_cop` so the widget can render inflows vs outflows.
 *
 * Currency: `amount_cop` is an INTEGER COP-pesos value with the original sign
 * preserved. USD transactions are converted at the current TRM in JS (after
 * the DB round-trip) so we stay on the same FX source used elsewhere. This
 * keeps the SQL simple at the cost of one FX fetch per USD-present response.
 *
 * Category lookup: per-user categories are unique on `(user_id, slug)` — the
 * JOIN MUST pair on both columns (memory `per-user-table-join-tenant-safety`,
 * incidents #336 / #338). Missing category (orphan slug after an archive)
 * returns `null` for both name and emoji without dropping the tx.
 *
 * `category_emoji`: the spec sample uses emoji ("🛒") but the categories
 * table stores a lucide icon name in `icon` (e.g. "shopping-cart"). For now
 * we pass `icon` through verbatim — the widget client decides how to render
 * it. When category emoji becomes a first-class column (separate issue),
 * swap this mapping.
 *
 * `account_label` uses `formatAccountLabel` — never concatenate inline
 * (memory `prod-accounts-seeded-2026-04-19`).
 *
 * Size rules:
 *   - `S` → 422 invalid_params (a single-row tile isn't useful for a feed).
 *   - `M` → 3 rows.
 *   - `L` → 5 rows.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, transactions, type AccountMetadata } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { toCop } from "@/lib/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import type { Currency } from "@/lib/types";
import type { WidgetHandler, WidgetHandlerResult } from "@/app/api/widget/v1/[id]/registry";
import { bogotaIsoNow } from "./_shared";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type RecentTxItem = {
  id: string;
  occurred_at: string;
  merchant: string | null;
  amount_cop: number;
  category_name: string | null;
  category_emoji: string | null;
  account_label: string;
};

type RecentTxData = {
  transactions: RecentTxItem[];
};

type RecentTxResponse = {
  widget_id: "recent-tx";
  size: "M" | "L";
  data: RecentTxData;
  generated_at: string;
};

type RecentTxErrorCode = "invalid_params";

type RecentTxErrorBody = { error: { code: RecentTxErrorCode; message: string } };

const STATUS_BY_CODE: Record<RecentTxErrorCode, number> = {
  invalid_params: 422,
};

function errorResult(code: RecentTxErrorCode, message: string): WidgetHandlerResult {
  const body: RecentTxErrorBody = { error: { code, message } };
  return { body, status: STATUS_BY_CODE[code] };
}

// ---------------------------------------------------------------------------
// Bogota ISO formatter for a given UTC Date. Colombia is UTC-5 year-round
// (no DST) so we shift by a constant and format by hand — mirrors the style
// of `bogotaIsoNow` in `_shared.ts` but anchored to an arbitrary occurredAt,
// not "now".
// ---------------------------------------------------------------------------

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

function bogotaIso(occurredAt: Date): string {
  const shifted = new Date(occurredAt.getTime() - BOGOTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}-05:00`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const BI_ZERO = BigInt(0);
const BI_HUNDRED = BigInt(100);

/**
 * Narrows signed COP cents to an integer peso value, preserving sign. A
 * negative `amountCents` rounds TOWARDS ZERO under BigInt division — which
 * drops the sub-peso remainder the same way positive values do, so the sign
 * is preserved and the magnitude stays consistent across inflows/outflows.
 */
function centsToCopSigned(cents: bigint): number {
  return Number(cents / BI_HUNDRED);
}

export const recentTxHandler: WidgetHandler = async (ctx) => {
  if (ctx.size === "S") {
    return errorResult("invalid_params", "recent-tx does not support size S");
  }

  const limit = ctx.size === "M" ? 3 : 5;

  // Single round-trip. LEFT JOIN to accounts (not INNER) because a tx always
  // has an account, but an outer join lets the query planner skip a nested
  // lookup when `accounts` is small. LEFT JOIN to categories so a tx whose
  // category was archived still shows up with null name/emoji.
  //
  // CRITICAL: both JOINs pair userId into the ON clause. Category slug is
  // unique per-user (#336, #338), and while account_id is already globally
  // unique, matching on userId too keeps the query defensively tenant-safe
  // and matches the project-wide convention.
  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      categoryName: categories.name,
      categoryIcon: categories.icon,
      accountName: accounts.name,
      accountCurrency: accounts.currency,
      accountInstitution: accounts.institution,
      accountMetadata: accounts.metadata,
    })
    .from(transactions)
    .leftJoin(
      accounts,
      and(eq(accounts.id, transactions.accountId), eq(accounts.userId, transactions.userId)),
    )
    .leftJoin(
      categories,
      and(
        eq(categories.slug, transactions.categorySlug),
        eq(categories.userId, transactions.userId),
        notDeleted(categories.deletedAt),
      ),
    )
    .where(
      and(
        eq(transactions.userId, ctx.userId),
        notDeleted(transactions.deletedAt),
        // Balance-adjustment filter uses BOTH signals — `source =
        // 'balance_adjustment'` is the provenance marker used by the
        // reconciliation writer, `is_adjustment` is the query-time flag
        // for YNAB-style balance corrections. Either one disqualifies.
        notAdjustment(transactions.isAdjustment),
        sql`${transactions.source} <> 'balance_adjustment'`,
      ),
    )
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(limit);

  // FX: only fetch when a USD row survived the filters. COP-only users pay
  // nothing — same optimization as `hoy` / `mis-tcs` / `mes-actual`.
  const needsFx = rows.some((r) => r.currency === "USD" && BigInt(r.amountCents) !== BI_ZERO);
  const fxRate = needsFx ? (await getCurrentFxRate()).rate : 0;

  const items: RecentTxItem[] = rows.map((r) => {
    const currency = r.currency as Currency;
    const amountCopCents = toCop(BigInt(r.amountCents), currency, fxRate);

    // Account label uses the centralized formatter. The row MUST have an
    // account (FK is NOT NULL on transactions.account_id), but the left
    // join typing forces us to guard against null. Fall back to a minimal
    // shape on the theoretical miss — preserves the response rather than
    // 500ing on a now-impossible edge.
    const accountLabel =
      r.accountName && r.accountCurrency
        ? formatAccountLabel({
            name: r.accountName,
            currency: r.accountCurrency,
            institution: r.accountInstitution ?? null,
            metadata: (r.accountMetadata ?? {}) as AccountMetadata,
          })
        : "—";

    return {
      id: String(r.id),
      occurred_at: bogotaIso(r.occurredAt),
      merchant: r.merchant,
      amount_cop: centsToCopSigned(amountCopCents),
      category_name: r.categoryName,
      category_emoji: r.categoryIcon,
      account_label: accountLabel,
    };
  });

  const body: RecentTxResponse = {
    widget_id: "recent-tx",
    size: ctx.size,
    data: {
      transactions: items,
    },
    generated_at: bogotaIsoNow(new Date()),
  };
  return { body };
};
