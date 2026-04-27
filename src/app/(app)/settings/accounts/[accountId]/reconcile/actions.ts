"use server";

import { revalidatePath } from "next/cache";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import {
  commitReconciliation,
  hashFileBuffer,
  recordReconciliationDecision,
} from "@/lib/reconciliation/commit";
import { parseAny } from "@/lib/reconciliation/dispatch";
import { matchStatement } from "@/lib/reconciliation/engine/match";
import type { ExistingTxnForMatch, MatchingPlan } from "@/lib/reconciliation/engine/types";
import type { ParsedStatement } from "@/lib/reconciliation/parsers/types";
import { createLogger } from "@/lib/logger";
import { expandReconcileWindow } from "./window";

const log = createLogger({ module: "reconciliation-actions" });

const accountIdSchema = z.object({ accountId: z.coerce.number().int().positive() });

const MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface ReconcilePreview {
  accountId: number;
  fileHash: string;
  parsed: SerializedParsed;
  plan: MatchingPlan;
  // #444 — populated when the parsed xlsx contains rows of a currency that
  // doesn't match the origin account, and the origin is linked via
  // `physicalCardId` to a sibling in the other currency. Tells the UI to
  // surface "se aplicará a 2 cuentas" and tells applyReconcile which sibling
  // to route the other-currency rows into. Null for single-currency uploads.
  multiCurrency: MultiCurrencyDispatchInfo | null;
}

export interface MultiCurrencyDispatchInfo {
  siblingAccountId: number;
  siblingCurrency: "COP" | "USD";
  originCurrency: "COP" | "USD";
  // Pre-computed counts per currency so the preview UI can render a
  // "N COP + M USD" banner without re-walking parsed.rows.
  rowsByCurrency: Record<"COP" | "USD", number>;
}

interface SerializedParsedRow {
  occurredAt: string;
  amountCents: string;
  currency: "COP" | "USD";
  direction: "in" | "out";
  descriptionRaw: string;
  rawData: Record<string, unknown>;
  isMetadata: boolean;
}

interface SerializedParsed {
  bank: "bancolombia";
  format: "bancolombia_savings" | "bancolombia_tc";
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  balanceAtEndCents: string | null;
  rows: SerializedParsedRow[];
}

function serializeParsed(parsed: ParsedStatement): SerializedParsed {
  return {
    bank: parsed.bank,
    format: parsed.format,
    periodStart: parsed.periodStart.toISOString(),
    periodEnd: parsed.periodEnd.toISOString(),
    rowCount: parsed.rowCount,
    balanceAtEndCents: parsed.balanceAtEndCents?.toString() ?? null,
    rows: parsed.rows.map((r) => ({
      occurredAt: r.occurredAt.toISOString(),
      amountCents: r.amountCents.toString(),
      currency: r.currency,
      direction: r.direction,
      descriptionRaw: r.descriptionRaw,
      rawData: r.rawData,
      isMetadata: r.isMetadata,
    })),
  };
}

function deserializeParsed(s: SerializedParsed): ParsedStatement {
  return {
    bank: s.bank,
    format: s.format,
    periodStart: new Date(s.periodStart),
    periodEnd: new Date(s.periodEnd),
    rowCount: s.rowCount,
    balanceAtEndCents: s.balanceAtEndCents ? BigInt(s.balanceAtEndCents) : null,
    rows: s.rows.map((r) => ({
      occurredAt: new Date(r.occurredAt),
      amountCents: BigInt(r.amountCents),
      currency: r.currency,
      direction: r.direction,
      descriptionRaw: r.descriptionRaw,
      rawData: r.rawData,
      isMetadata: r.isMetadata,
    })),
  };
}

async function loadAccount(userId: number, accountId: number) {
  const [account] = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!account) throw new Error("account_not_found");
  return account;
}

// #444 — finds the other-currency sibling linked to the same physical card.
// Returns null when the origin isn't linked to a plastic or has no sibling.
async function loadReconcileSibling(
  userId: number,
  physicalCardId: string,
  excludeAccountId: number,
) {
  const [sibling] = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.physicalCardId, physicalCardId),
        ne(accounts.id, excludeAccountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  return sibling ?? null;
}

type ReconcileDispatch = {
  origin: Awaited<ReturnType<typeof loadAccount>>;
  sibling: Awaited<ReturnType<typeof loadAccount>> | null;
};

// #444 — decides whether a parsed statement must dispatch to the origin
// account alone (single-currency) or split across an origin + plastic-linked
// sibling (Mastercard Internacional mixing COP+USD in one sheet).
//
// Validates upfront: every parsed row's currency must land on either origin
// or sibling; otherwise we throw a precise error the UI can translate.
async function resolveReconcileDispatch(
  userId: number,
  origin: Awaited<ReturnType<typeof loadAccount>>,
  parsed: ParsedStatement,
): Promise<ReconcileDispatch> {
  const currenciesInFile = new Set<"COP" | "USD">();
  for (const row of parsed.rows) currenciesInFile.add(row.currency);

  if (currenciesInFile.size <= 1) {
    const only = currenciesInFile.values().next().value as "COP" | "USD" | undefined;
    if (only !== undefined && only !== origin.currency) {
      throw new Error(`currency_mismatch:file=${only},account=${origin.currency}`);
    }
    return { origin, sibling: null };
  }

  // Multi-currency xlsx — we need a plastic-linked sibling to absorb the
  // other-currency rows. Without one we reject (issue #444 acceptance: rows
  // must never land on an account whose currency doesn't match).
  if (!origin.physicalCardId) {
    throw new Error("multi_currency_without_physical_card");
  }
  const sibling = await loadReconcileSibling(userId, origin.physicalCardId, origin.id);
  if (!sibling) {
    // Name the error by the missing currency (COP or USD) so the UI can point
    // the user at exactly which sub-account is missing.
    const missing = [...currenciesInFile].find((c) => c !== origin.currency);
    throw new Error(`missing_${(missing ?? "usd").toLowerCase()}_sibling`);
  }
  if (sibling.institutionSlug !== origin.institutionSlug) {
    throw new Error(`sibling_institution_mismatch:${sibling.institutionSlug}`);
  }
  // Every parsed row must land on origin or sibling — guard against a 3rd
  // currency leaking in through a future parser change.
  for (const c of currenciesInFile) {
    if (c !== origin.currency && c !== sibling.currency) {
      throw new Error(`currency_not_in_plastic:${c}`);
    }
  }
  return { origin, sibling };
}

function rowsByCurrencyCount(parsed: ParsedStatement): Record<"COP" | "USD", number> {
  const counts: Record<"COP" | "USD", number> = { COP: 0, USD: 0 };
  for (const row of parsed.rows) counts[row.currency] += 1;
  return counts;
}

async function loadExistingTxns(
  userId: number,
  accountId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<ExistingTxnForMatch[]> {
  const { windowStart, windowEnd } = expandReconcileWindow(periodStart, periodEnd);
  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      channel: transactions.channel,
      isAdjustment: transactions.isAdjustment,
      reconciliationStatus: transactions.reconciliationStatus,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
    channel: r.channel,
    isAdjustment: r.isAdjustment,
    reconciliationStatus: r.reconciliationStatus,
  }));
}

export async function previewReconcile(formData: FormData): Promise<ReconcilePreview> {
  const session = await getSessionUser();
  const { accountId } = accountIdSchema.parse({ accountId: formData.get("accountId") });

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("no_file");
  if (file.size === 0) throw new Error("empty_file");
  if (file.size > MAX_FILE_SIZE) throw new Error("file_too_large");

  const account = await loadAccount(session.id, accountId);

  const buf = Buffer.from(await file.arrayBuffer());
  const fileHash = hashFileBuffer(buf);
  const { detected, parsed } = parseAny(buf);

  if (detected.bank !== account.institutionSlug) {
    log.warn(
      {
        event: "parser_bank_mismatch",
        detectedBank: detected.bank,
        accountInstitutionSlug: account.institutionSlug,
        userId: session.id,
      },
      "parser bank mismatch",
    );
    throw new Error(
      `parser_bank_mismatch:file=${detected.bank},account=${account.institutionSlug}`,
    );
  }

  // #444 — resolve multi-currency dispatch. For single-currency uploads this
  // is a no-op (sibling=null) and the flow proceeds account-scoped. For
  // Mastercard Internacional xlsx mixing COP+USD we fetch the plastic-linked
  // sibling and load existingTxns from BOTH sides so the match engine can see
  // candidates across currencies.
  const dispatch = await resolveReconcileDispatch(session.id, account, parsed);

  const existingOrigin = await loadExistingTxns(
    session.id,
    account.id,
    parsed.periodStart,
    parsed.periodEnd,
  );
  const existingSibling = dispatch.sibling
    ? await loadExistingTxns(session.id, dispatch.sibling.id, parsed.periodStart, parsed.periodEnd)
    : [];
  const existing: ExistingTxnForMatch[] = [...existingOrigin, ...existingSibling];
  const plan = matchStatement({
    parsedRows: parsed.rows,
    existingTxns: existing,
    period: { start: parsed.periodStart, end: parsed.periodEnd },
  });

  const multiCurrency: MultiCurrencyDispatchInfo | null = dispatch.sibling
    ? {
        siblingAccountId: dispatch.sibling.id,
        siblingCurrency: dispatch.sibling.currency,
        originCurrency: account.currency,
        rowsByCurrency: rowsByCurrencyCount(parsed),
      }
    : null;

  return {
    accountId: account.id,
    fileHash,
    parsed: serializeParsed(parsed),
    plan,
    multiCurrency,
  };
}

const applySchema = z.object({
  accountId: z.coerce.number().int().positive(),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  parsed: z.any(),
  plan: z.any(),
  userBalanceAtEndCents: z
    .string()
    .regex(/^-?\d+$/)
    .nullable()
    .optional(),
});

export type ApplyReconcileInput = z.infer<typeof applySchema>;

export async function applyReconcile(input: ApplyReconcileInput) {
  const session = await getSessionUser();
  const { accountId, fileHash, parsed, plan, userBalanceAtEndCents } = applySchema.parse(input);
  const account = await loadAccount(session.id, accountId);

  const parsedStatement = deserializeParsed(parsed as SerializedParsed);
  // #444 — re-resolve dispatch on the server (don't trust client-side state).
  // Matches the preview call so the commit routes every row through the same
  // plastic-aware plan.
  const dispatch = await resolveReconcileDispatch(session.id, account, parsedStatement);
  const result = await commitReconciliation({
    userId: session.id,
    account: { id: dispatch.origin.id, currency: dispatch.origin.currency },
    siblingAccount: dispatch.sibling
      ? { id: dispatch.sibling.id, currency: dispatch.sibling.currency }
      : undefined,
    parsed: parsedStatement,
    plan: plan as MatchingPlan,
    fileHash,
    // `userBalanceAtEndCents` is a single-account concept — the commit layer
    // ignores it in multi-currency mode, but we also pass null explicitly
    // here so the intent is obvious at the call site.
    userBalanceAtEndCents: dispatch.sibling
      ? null
      : userBalanceAtEndCents
        ? BigInt(userBalanceAtEndCents)
        : null,
  });

  log.info(
    {
      event: "reconciliation_applied",
      userId: session.id,
      accountId: account.id,
      siblingAccountId: dispatch.sibling?.id ?? null,
      statementImportId: result.statementImportId,
      status: result.status,
      inserted: result.inserted,
      matched: result.matched,
      flagged: result.flagged,
    },
    "reconciliation applied",
  );

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath(`/settings/accounts/${account.id}/reconcile`);
  if (dispatch.sibling) {
    revalidatePath(`/settings/accounts/${dispatch.sibling.id}/reconcile`);
  }

  return result;
}

const reviewSchema = z.object({
  txnId: z.coerce.number().int().positive(),
  action: z.enum(["archived", "kept", "merged_into"]),
  mergedIntoTxnId: z.coerce.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

export type ReviewReconciliationInput = z.infer<typeof reviewSchema>;

export async function reviewReconciliationDecision(input: ReviewReconciliationInput) {
  const session = await getSessionUser();
  const parsed = reviewSchema.parse(input);
  await recordReconciliationDecision({
    userId: session.id,
    txnId: parsed.txnId,
    action: parsed.action,
    mergedIntoTxnId: parsed.mergedIntoTxnId,
    note: parsed.note,
  });
  revalidatePath("/transactions");
  return { ok: true as const };
}
