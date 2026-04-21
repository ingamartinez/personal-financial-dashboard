"use server";

import { revalidatePath } from "next/cache";
import { and, eq, gte, lte } from "drizzle-orm";
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

const log = createLogger({ module: "reconciliation-actions" });

const accountIdSchema = z.object({ accountId: z.coerce.number().int().positive() });

const MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface ReconcilePreview {
  accountId: number;
  fileHash: string;
  parsed: SerializedParsed;
  plan: MatchingPlan;
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
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!account) throw new Error("account_not_found");
  return account;
}

async function loadExistingTxns(
  userId: number,
  accountId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<ExistingTxnForMatch[]> {
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
        gte(transactions.occurredAt, periodStart),
        lte(transactions.occurredAt, periodEnd),
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

  const existing = await loadExistingTxns(
    session.id,
    account.id,
    parsed.periodStart,
    parsed.periodEnd,
  );
  const plan = matchStatement({ parsedRows: parsed.rows, existingTxns: existing });

  return {
    accountId: account.id,
    fileHash,
    parsed: serializeParsed(parsed),
    plan,
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
  const result = await commitReconciliation({
    userId: session.id,
    account: { id: account.id, currency: account.currency },
    parsed: parsedStatement,
    plan: plan as MatchingPlan,
    fileHash,
    userBalanceAtEndCents: userBalanceAtEndCents ? BigInt(userBalanceAtEndCents) : null,
  });

  log.info(
    {
      event: "reconciliation_applied",
      userId: session.id,
      accountId: account.id,
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
