"use server";

// #622: Server actions for forecast overlay row interactions.
// These wrap the existing gap actions from settings/recurring/actions.ts
// so the /transactions page can call them without duplicating logic.

import { revalidatePath } from "next/cache";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import {
  getExpectedOccurrencesForMonth,
  buildExpectedDate,
} from "@/lib/recurring/expected-occurrences";
import { promoteUpcoming, dismissUpcoming } from "@/app/(app)/settings/recurring/actions";
import { createLogger } from "@/lib/logger";
import type { ExpectedOccurrence } from "@/lib/recurring/expected-occurrences";

const log = createLogger({ module: "transactions/forecast-actions" });

// ---------------------------------------------------------------------------
// Types (put in a sibling types file pattern — but these are simple enough to inline)
// ---------------------------------------------------------------------------

export type ForecastOccurrence = ExpectedOccurrence & {
  // Serialized-safe version: Date → string for RSC prop passing.
  expectedDateIso: string;
  accountName: string;
  accountCurrency: string;
};

// ---------------------------------------------------------------------------
// Get expected occurrences for a yearMonth (called from RSC page).
// We need this as a regular async function (not "use server" action) so the
// RSC page can call it directly. It's in this file for co-location with the
// form actions.
// ---------------------------------------------------------------------------

export async function getForecastOccurrences(
  userId: number,
  yearMonth: string,
  today?: Date,
): Promise<ForecastOccurrence[]> {
  const occurrences = await getExpectedOccurrencesForMonth(userId, yearMonth, today);

  if (occurrences.length === 0) return [];

  const accountIds = [...new Set(occurrences.map((o) => o.accountId))];
  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.id, accountIds),
        notDeleted(accounts.deletedAt),
      ),
    );

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  return occurrences
    .filter((o) => accountMap.has(o.accountId))
    .map((o) => {
      const acc = accountMap.get(o.accountId)!;
      return {
        ...o,
        expectedDateIso: o.expectedDate.toISOString(),
        accountName: acc.name,
        accountCurrency: acc.currency,
      };
    });
}

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
// Default scope: same account, ±10d/+5d window around expectedDate, unlinked.
// Toggle: all tx for the user in the same yearMonth (no account/date filter).
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

const linkCandidatesSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  showAll: z.boolean().optional().default(false),
});

export type GetLinkCandidatesInput = z.input<typeof linkCandidatesSchema>;

/** Window constants matching gap-detector for consistency. */
const WINDOW_BEFORE_DAYS = 10;
const WINDOW_AFTER_DAYS = 5;

export async function getLinkCandidatesForForecast(
  input: GetLinkCandidatesInput,
): Promise<ForecastLinkCandidate[]> {
  const session = await getSessionUser();
  const parsed = linkCandidatesSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Input inválido");

  const { recurringId, yearMonth, showAll } = parsed.data;

  // Fetch the recurring to get accountId + dayOfMonth — tenant-safe.
  const [recurring] = await db
    .select({
      accountId: recurringTransactions.accountId,
      dayOfMonth: recurringTransactions.dayOfMonth,
      label: recurringTransactions.label,
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

  // Build the WHERE conditions.
  let rows;

  if (showAll) {
    // "Mostrar todas las tx del mes" — all user tx in that yearMonth, unlinked.
    const [ym_y, ym_m] = yearMonth.split("-").map(Number);
    const monthStart = new Date(Date.UTC(ym_y, ym_m - 1, 1));
    const monthEnd = new Date(Date.UTC(ym_y, ym_m, 0, 23, 59, 59, 999));

    rows = await db
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
          gte(transactions.occurredAt, monthStart),
          lte(transactions.occurredAt, monthEnd),
          notDeleted(transactions.deletedAt),
        ),
      )
      .orderBy(desc(transactions.occurredAt));
  } else {
    // Default: same account, ±10d/+5d window around expectedDate, unlinked.
    const windowStart = new Date(expectedDate.getTime() - WINDOW_BEFORE_DAYS * 86400000);
    const windowEnd = new Date(expectedDate.getTime() + WINDOW_AFTER_DAYS * 86400000 + 86399999);

    rows = await db
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
          eq(transactions.accountId, recurring.accountId),
          isNull(transactions.recurringId),
          gte(transactions.occurredAt, windowStart),
          lte(transactions.occurredAt, windowEnd),
          notDeleted(transactions.deletedAt),
        ),
      )
      .orderBy(desc(transactions.occurredAt));
  }

  if (rows.length === 0) return [];

  // Fetch account names for display.
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

  // Sort by proximity to expectedDate (closest first).
  const expectedMs = expectedDate.getTime();
  const sorted = rows.slice().sort((a, b) => {
    const da = Math.abs(a.occurredAt.getTime() - expectedMs);
    const db_ = Math.abs(b.occurredAt.getTime() - expectedMs);
    return da - db_;
  });

  return sorted.map((r) => ({
    txId: r.id,
    occurredAt: r.occurredAt,
    occurredAtIso: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
    accountName: accountMap.get(r.accountId)?.name ?? "?",
  }));
}
