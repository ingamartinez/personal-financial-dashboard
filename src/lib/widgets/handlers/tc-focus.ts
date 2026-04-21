/**
 * Widget handler: `tc-focus` — cupo + utilization snapshot for ONE credit card.
 *
 * Supports both card shapes the codebase carries today (#346):
 *
 * - Single-currency TC  → `target` is an `accounts.id` (integer). Cupo lives on
 *   `accounts.metadata.creditLimitCents` and the statement cutoff day on
 *   `metadata.cutoffDay`. Balance is the derived SUM(transactions.amount_cents)
 *   for that account — stored as negative debt, so `used = |balance|` and
 *   `available = limit + balance`.
 *
 * - Multi-currency TC   → `target` is a `physical_cards.id` (uuid). The shared
 *   COP cupo + statement cutoff live on the `physical_cards` row, and the
 *   sub-accounts (COP + USD) hold the per-currency balances. We delegate the
 *   available-credit math to `getAvailableCreditCOP`, which handles USD→COP
 *   conversion at the current TRM.
 *
 * `target` is dispatched by UUID shape: anything that parses as a UUID is
 * tried against `physical_cards` first; otherwise it is parsed as an integer
 * account id. If neither resolves for the requesting user → 404 with code
 * `target_not_found`. Cross-tenant `target`s fall through the same 404 — the
 * handler NEVER reveals whether the id exists under a different user.
 *
 * Size: `tc-focus` is designed for a small home-screen tile; only `size=S` is
 * supported. `M`/`L` requests return 422 `invalid_params` at the handler layer.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { derivedBalanceCentsSql, getAvailableCreditCOP } from "@/lib/accounts/queries";
import { notDeleted } from "@/lib/db/helpers";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { createLogger } from "@/lib/logger";
import { formatAccountLabel } from "@/lib/accounts/format";
import type { WidgetHandler, WidgetHandlerResult } from "@/app/api/widget/v1/[id]/registry";

const log = createLogger({ module: "widget-tc-focus" });

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type TcFocusData = {
  card_name: string;
  network: string | null;
  last4: string | null;
  credit_limit_cop: number;
  used_cop: number;
  available_cop: number;
  utilization_pct: number;
  next_statement_cutoff: string | null;
  days_to_cutoff: number | null;
};

type TcFocusResponse = {
  widget_id: "tc-focus";
  size: "S";
  data: TcFocusData;
  generated_at: string;
};

type TcFocusErrorCode = "target_not_found" | "invalid_params";

type TcFocusErrorBody = { error: { code: TcFocusErrorCode; message: string } };

const STATUS_BY_CODE: Record<TcFocusErrorCode, number> = {
  target_not_found: 404,
  invalid_params: 422,
};

function errorResult(code: TcFocusErrorCode, message: string): WidgetHandlerResult {
  const body: TcFocusErrorBody = { error: { code, message } };
  return { body, status: STATUS_BY_CODE[code] };
}

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

const querySchema = z.object({
  target: z.string().min(1, "target is required"),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Bogota-aware date helpers — Colombia has no DST, so a fixed UTC-5 offset is
// exact. We keep the math in milliseconds to avoid Date#getXxx() surprises at
// month boundaries.
// ---------------------------------------------------------------------------

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

type BogotaYmd = { year: number; month: number; day: number };

function nowInBogota(now: Date): BogotaYmd {
  const shifted = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1..12
    day: shifted.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number): number {
  // month is 1..12; Date(year, month, 0) gives the last day of `month`.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Given a statement cutoff day-of-month (1..31), returns the ISO date of the
 * NEXT cutoff and the number of days between today (Bogota) and that cutoff.
 *
 * Rules:
 * - If `cutoffDay > today.day` → cutoff is this month.
 * - Else → cutoff is next month.
 * - If `cutoffDay` exceeds the target month's last day (e.g. cutoff=31 in
 *   February), clamp to the last day of that month.
 */
export function computeNextCutoff(
  cutoffDay: number,
  today: BogotaYmd,
): { next: string; daysTo: number } {
  const inThisMonth = cutoffDay > today.day;
  const year0 = today.year;
  const month0 = today.month;
  const targetYear = inThisMonth || month0 < 12 ? year0 : year0 + 1;
  const targetMonth = inThisMonth ? month0 : month0 === 12 ? 1 : month0 + 1;
  const clampedDay = Math.min(cutoffDay, daysInMonth(targetYear, targetMonth));
  const next = formatYmd(targetYear, targetMonth, clampedDay);
  // Day count via UTC midnight diff — both dates are "dates" in Bogota, so the
  // offset cancels out; we just need whole-day subtraction.
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const nextUtc = Date.UTC(targetYear, targetMonth - 1, clampedDay);
  const daysTo = Math.round((nextUtc - todayUtc) / (24 * 60 * 60 * 1000));
  return { next, daysTo };
}

// Bogota-offset ISO-8601 — e.g. `2026-04-21T17:23:00-05:00`. We format without
// seconds of precision finer than whole-second and without milliseconds, which
// matches the issue's sample response.
function bogotaIsoNow(now: Date): string {
  const shifted = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}-05:00`;
}

// ---------------------------------------------------------------------------
// Money helpers — everything out of the DB is bigint cents. The widget
// contract exposes COP as integer pesos (no cents shown in the tile).
// ---------------------------------------------------------------------------

const BI_ZERO = BigInt(0);
const BI_HUNDRED = BigInt(100);
const BI_TEN_THOUSAND = BigInt(10000);

function centsToCop(cents: bigint): number {
  // Integer division in bigint-space, then narrow to number. COP amounts we
  // expect here (cupo, balances) comfortably fit in Number.MAX_SAFE_INTEGER
  // after dividing by 100.
  return Number(cents / BI_HUNDRED);
}

function roundUtilizationPct(used: bigint, limit: bigint): number {
  if (limit <= BI_ZERO) return 0;
  // (used * 10000) / limit yields "percent * 100"; round to integer percent.
  const scaled = (used * BI_TEN_THOUSAND) / limit;
  return Math.round(Number(scaled) / 100);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const tcFocusHandler: WidgetHandler = async (ctx) => {
  // Size constraint — tile-only widget.
  if (ctx.size !== "S") {
    return errorResult("invalid_params", "tc-focus only supports size S");
  }

  // target param — Zod enforces required/string; shape dispatch happens next.
  const parsed = querySchema.safeParse({ target: ctx.searchParams.get("target") });
  if (!parsed.success) {
    return errorResult("invalid_params", "target query param is required");
  }
  const target = parsed.data.target;

  const now = new Date();
  const today = nowInBogota(now);

  // --- Multi-currency path: UUID targets look up physical_cards first. ----
  if (UUID_RE.test(target)) {
    const [pc] = await db
      .select({
        id: physicalCards.id,
        name: physicalCards.name,
        network: physicalCards.network,
        last4: physicalCards.last4,
        institution: physicalCards.institution,
        creditLimitCents: physicalCards.creditLimitCents,
        statementCutoffDay: physicalCards.statementCutoffDay,
      })
      .from(physicalCards)
      .where(and(eq(physicalCards.id, target), eq(physicalCards.userId, ctx.userId)))
      .limit(1);

    if (pc) {
      const fx = await getCurrentFxRate();
      const availableCents = await getAvailableCreditCOP(ctx.userId, pc.id, fx.rate);
      if (availableCents === null) {
        // Belt-and-braces — the SELECT above proved the row exists, but the
        // helper has its own tenancy guard and might disagree if a race
        // deleted the card between calls. Surface as 404, not 500.
        log.warn(
          {
            event: "tc_focus_available_mismatch",
            userId: ctx.userId,
            physicalCardId: pc.id,
          },
          "physical card exists but available-credit query returned null",
        );
        return errorResult("target_not_found", "Credit card not found");
      }

      const limitCents = pc.creditLimitCents;
      // used = limit - available (in COP cents). Clamp at 0 to avoid negative
      // utilization if the user is somehow above the cupo in the ledger.
      const usedCents = limitCents - availableCents;
      const usedClamped = usedCents < BI_ZERO ? BI_ZERO : usedCents;
      const utilizationPct = roundUtilizationPct(usedClamped, limitCents);

      const cutoff =
        pc.statementCutoffDay !== null && pc.statementCutoffDay !== undefined
          ? computeNextCutoff(pc.statementCutoffDay, today)
          : null;

      const cardName =
        pc.name?.trim() ||
        [pc.institution, pc.last4 ? `*${pc.last4}` : null].filter(Boolean).join(" ") ||
        "Tarjeta de crédito";

      const body: TcFocusResponse = {
        widget_id: "tc-focus",
        size: "S",
        data: {
          card_name: cardName,
          network: pc.network,
          last4: pc.last4,
          credit_limit_cop: centsToCop(limitCents),
          used_cop: centsToCop(usedClamped),
          available_cop: centsToCop(availableCents < BI_ZERO ? BI_ZERO : availableCents),
          utilization_pct: utilizationPct,
          next_statement_cutoff: cutoff?.next ?? null,
          days_to_cutoff: cutoff?.daysTo ?? null,
        },
        generated_at: bogotaIsoNow(now),
      };
      return { body };
    }
    // UUID but not one of this user's physical cards → 404. Do NOT fall
    // through to accounts.id lookup (account ids are ints, never UUIDs).
    return errorResult("target_not_found", "Credit card not found");
  }

  // --- Single-currency path: parse target as an accounts.id integer. -----
  const asInt = Number(target);
  if (!Number.isInteger(asInt) || asInt <= 0 || String(asInt) !== target) {
    return errorResult("target_not_found", "Credit card not found");
  }

  const [acc] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      currency: accounts.currency,
      type: accounts.type,
      metadata: accounts.metadata,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, asInt),
        eq(accounts.userId, ctx.userId),
        eq(accounts.type, "credit_card"),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!acc) {
    return errorResult("target_not_found", "Credit card not found");
  }

  const metadata = (acc.metadata ?? {}) as AccountMetadata;
  const limitCents = BigInt(metadata.creditLimitCents ?? 0);
  const balanceCents = BigInt(acc.balanceCents);

  // Credit card balances are stored as negative debt; absolute value = used.
  const usedCents = balanceCents < BI_ZERO ? -balanceCents : BI_ZERO;
  const availableCents = limitCents - usedCents < BI_ZERO ? BI_ZERO : limitCents - usedCents;
  const utilizationPct = roundUtilizationPct(usedCents, limitCents);

  const cutoffDay = metadata.cutoffDay ?? null;
  const cutoff = cutoffDay !== null ? computeNextCutoff(cutoffDay, today) : null;

  // For single-currency cards the ledger already embeds last4 in the account
  // name (legacy) OR keeps it on metadata.last4s — prefer the latter.
  const last4 = metadata.last4s?.[0] ?? null;
  const network = metadata.network ?? null;

  const cardName = formatAccountLabel({
    name: acc.name,
    currency: acc.currency,
    institution: acc.institution,
    metadata: { last4s: metadata.last4s ?? null },
  });

  const body: TcFocusResponse = {
    widget_id: "tc-focus",
    size: "S",
    data: {
      card_name: cardName,
      network,
      last4,
      credit_limit_cop: centsToCop(limitCents),
      used_cop: centsToCop(usedCents),
      available_cop: centsToCop(availableCents),
      utilization_pct: utilizationPct,
      next_statement_cutoff: cutoff?.next ?? null,
      days_to_cutoff: cutoff?.daysTo ?? null,
    },
    generated_at: bogotaIsoNow(now),
  };
  return { body };
};
