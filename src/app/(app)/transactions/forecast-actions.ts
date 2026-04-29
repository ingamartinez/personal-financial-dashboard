"use server";

// #622: Server actions for forecast overlay row interactions.
// These wrap the existing gap actions from settings/recurring/actions.ts
// so the /transactions page can call them without duplicating logic.
//
// NOTE: getForecastOccurrences and ForecastOccurrence type have been moved to
// @/lib/recurring/expected-occurrences — they accept userId as a parameter so
// they must NOT live in a "use server" file (C1 tenant safety fix).

import { revalidatePath } from "next/cache";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { buildExpectedDate } from "@/lib/recurring/expected-occurrences";
import { promoteUpcoming, dismissUpcoming } from "@/app/(app)/settings/recurring/actions";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "transactions/forecast-actions" });

// ---------------------------------------------------------------------------
// "Pagué $___ " → createSyntheticForGap
// Wraps promoteUpcoming from settings/recurring/actions.ts.
// ---------------------------------------------------------------------------

const createSyntheticSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Amount as decimal string (e.g. "50000" or "50000.00").
  // We pass it through to promoteUpcoming which handles the sign.
  amountCents: z.union([z.string().regex(/^-?\d+$/), z.bigint(), z.number().int()]).optional(),
});

export type CreateSyntheticInput = z.input<typeof createSyntheticSchema>;

export async function createSyntheticForGap(input: CreateSyntheticInput) {
  const session = await getSessionUser();
  const parsed = createSyntheticSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Input inválido");
  }

  log.info(
    {
      event: "forecast_create_synthetic",
      userId: session.id,
      recurringId: parsed.data.recurringId,
      yearMonth: parsed.data.yearMonth,
    },
    "creating synthetic tx from forecast row",
  );

  await promoteUpcoming({
    recurringId: parsed.data.recurringId,
    yearMonth: parsed.data.yearMonth,
    occurredOn: parsed.data.occurredOn,
    amountCents: parsed.data.amountCents as string | undefined,
  });

  revalidatePath("/");
  revalidatePath("/transactions");
}

// ---------------------------------------------------------------------------
// "No pagué" → skipGap
// Wraps dismissUpcoming from settings/recurring/actions.ts.
// ---------------------------------------------------------------------------

const skipGapSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
});

export type SkipGapInput = z.input<typeof skipGapSchema>;

export async function skipGap(input: SkipGapInput) {
  const session = await getSessionUser();
  const parsed = skipGapSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Input inválido");
  }

  log.info(
    {
      event: "forecast_skip_gap",
      userId: session.id,
      recurringId: parsed.data.recurringId,
      yearMonth: parsed.data.yearMonth,
    },
    "skipping forecast occurrence",
  );

  await dismissUpcoming({
    recurringId: parsed.data.recurringId,
    ym: parsed.data.yearMonth,
  });

  revalidatePath("/");
  revalidatePath("/transactions");
}

// ---------------------------------------------------------------------------
// Fetch tx candidates for the "Asociar tx existente" picker.
//
// #632 redesign — window-based always, ALL accounts by default:
//   Default: occurredAt ∈ [expectedDate-10d, expectedDate+5d], unlinked, ALL accounts.
//   showAll toggle: expands window to [expectedDate-30d, expectedDate+10d]. NEVER
//   falls back to month-calendar-based filtering.
// NEVER filters by amount — variable recurrings (ARQ, EPM) depend on this.
// ---------------------------------------------------------------------------

export type ForecastLinkCandidate = {
  txId: number;
  occurredAt: Date;
  occurredAtIso: string;
  amountCents: bigint;
  currency: string;
  descriptionRaw: string;
  merchant: string | null;
  accountName: string;
};

export type ForecastLinkCandidatesResult = {
  /** Candidates matching same currency + within ±20% of recurringAmountCents. */
  sugeridas: ForecastLinkCandidate[];
  /** All remaining candidates (not in sugeridas), or all candidates if no sugeridas. */
  todas: ForecastLinkCandidate[];
  /** The expected amount of the recurring (for UI display). */
  recurringAmountCents: bigint;
  /** The currency of the recurring. */
  recurringCurrency: string;
};

const linkCandidatesSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  /** When true, expands the window to [expectedDate-30d, expectedDate+10d]. */
  showAll: z.boolean().optional().default(false),
});

export type GetLinkCandidatesInput = z.input<typeof linkCandidatesSchema>;

/** Window constants matching gap-detector for consistency. */
const WINDOW_BEFORE_DAYS = 10;
const WINDOW_AFTER_DAYS = 5;
/** Extended window when showAll=true. */
const WINDOW_ALL_BEFORE_DAYS = 30;
const WINDOW_ALL_AFTER_DAYS = 10;

export async function getLinkCandidatesForForecast(
  input: GetLinkCandidatesInput,
): Promise<ForecastLinkCandidatesResult> {
  const session = await getSessionUser();
  const parsed = linkCandidatesSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Input inválido");

  const { recurringId, yearMonth, showAll } = parsed.data;

  // Fetch the recurring to get dayOfMonth + amount + currency — tenant-safe.
  const [recurring] = await db
    .select({
      accountId: recurringTransactions.accountId,
      dayOfMonth: recurringTransactions.dayOfMonth,
      label: recurringTransactions.label,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, session.id),
        eq(recurringTransactions.id, recurringId),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .limit(1);

  if (!recurring) throw new Error("Recurring no encontrado");

  const expectedDate = buildExpectedDate(recurring.dayOfMonth, yearMonth);

  // Window-based always. showAll expands the window but NEVER switches to month-calendar.
  const beforeDays = showAll ? WINDOW_ALL_BEFORE_DAYS : WINDOW_BEFORE_DAYS;
  const afterDays = showAll ? WINDOW_ALL_AFTER_DAYS : WINDOW_AFTER_DAYS;

  const windowStart = new Date(expectedDate.getTime() - beforeDays * 86400000);
  const windowEnd = new Date(expectedDate.getTime() + afterDays * 86400000 + 86399999);

  // ALL accounts — no account filter. Currency-agnostic at query level.
  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, session.id),
        isNull(transactions.recurringId),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    )
    .orderBy(desc(transactions.occurredAt));

  if (rows.length === 0) {
    return {
      sugeridas: [],
      todas: [],
      recurringAmountCents: recurring.amountCents,
      recurringCurrency: recurring.currency,
    };
  }

  // Fetch account names for display (tenant-safe: filter by userId).
  const rowAccountIds = [...new Set(rows.map((r) => r.accountId))];
  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        inArray(accounts.id, rowAccountIds),
        notDeleted(accounts.deletedAt),
      ),
    );
  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  const expectedMs = expectedDate.getTime();

  // Sort all rows by proximity to expectedDate (closest first).
  const sorted = rows.slice().sort((a, b) => {
    const da = Math.abs(a.occurredAt.getTime() - expectedMs);
    const db_ = Math.abs(b.occurredAt.getTime() - expectedMs);
    return da - db_;
  });

  const mapped: ForecastLinkCandidate[] = sorted.map((r) => ({
    txId: r.id,
    occurredAt: r.occurredAt,
    occurredAtIso: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
    accountName: formatAccountLabel(accountMap.get(r.accountId) ?? { name: "?", currency: "" }),
  }));

  // Build "Sugeridas": same currency + amount within ±20% of recurring.amountCents.
  // Signed comparison (both amounts carry the sign).
  const recAmt = recurring.amountCents;
  const recCurrency = recurring.currency;

  const sugeridasSet = new Set<number>();
  const sugeridas: ForecastLinkCandidate[] = [];

  for (const c of mapped) {
    if (c.currency !== recCurrency) continue;
    // ±20% window around the recurring amount (signed, absolute value for width).
    const absMagnitude = recAmt < BigInt(0) ? -recAmt : recAmt;
    const tolerance = (absMagnitude * BigInt(20)) / BigInt(100);
    const lower = recAmt - tolerance;
    const upper = recAmt + tolerance;
    // For negative amounts: lower is more negative (e.g. -120k), upper is less negative (-80k).
    // We check if c.amountCents is within [min(lower,upper), max(lower,upper)].
    const lo = lower < upper ? lower : upper;
    const hi = lower < upper ? upper : lower;
    if (c.amountCents >= lo && c.amountCents <= hi) {
      sugeridasSet.add(c.txId);
      sugeridas.push(c);
    }
  }

  // Sort sugeridas by amount-proximity to recurring.amountCents (closest first).
  sugeridas.sort((a, b) => {
    const da = a.amountCents - recAmt;
    const db_ = b.amountCents - recAmt;
    const absDa = da < BigInt(0) ? -da : da;
    const absDb_ = db_ < BigInt(0) ? -db_ : db_;
    return absDa < absDb_ ? -1 : absDa > absDb_ ? 1 : 0;
  });

  // Limit sugeridas to top 5.
  const topSugeridas = sugeridas.slice(0, 5);
  const topSugeridasSet = new Set(topSugeridas.map((c) => c.txId));

  // "Todas": remaining candidates sorted by date-proximity (already sorted).
  const todas = mapped.filter((c) => !topSugeridasSet.has(c.txId));

  return {
    sugeridas: topSugeridas,
    todas,
    recurringAmountCents: recAmt,
    recurringCurrency: recCurrency,
  };
}
