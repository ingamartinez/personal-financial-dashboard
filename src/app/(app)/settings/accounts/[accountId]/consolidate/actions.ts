"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import {
  consolidateCycleFromStatement,
  hashStatementBuffer,
  type ConsolidationReport,
} from "@/lib/ingestion/bancolombia-statement/consolidate";
import { parseBancolombiaStatementAllSheets } from "@/lib/ingestion/bancolombia-statement/xlsx";
import type { ParsedStatement } from "@/lib/ingestion/bancolombia-statement/types";
import { createLogger } from "@/lib/logger";

// Only async exports are allowed from a "use server" file in Next.js 16; types
// are elided at runtime and safe, but non-async helpers (e.g. type guards) must
// live in a non-server module — see `./consolidate-types`.
import type { ConsolidateActionResult } from "./consolidate-types";

const log = createLogger({ module: "consolidate-actions" });

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const inputSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  cycle: z.string().regex(/^\d{4}-\d{2}$/, "cycle must be YYYY-MM"),
});

type TcAccount = {
  id: number;
  name: string;
  currency: "COP" | "USD";
  institutionSlug: string;
  type: string;
  metadata: typeof accounts.$inferSelect.metadata;
  physicalCardId: string | null;
};

async function loadTcAccount(userId: number, accountId: number): Promise<TcAccount> {
  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      type: accounts.type,
      metadata: accounts.metadata,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!account) throw new Error("account_not_found");
  if (account.type !== "credit_card") {
    throw new Error("account_not_credit_card");
  }
  if (account.institutionSlug !== "bancolombia") {
    throw new Error(`unsupported_institution:${account.institutionSlug}`);
  }
  return account;
}

// For multi-sheet dispatch: given a credit_card account sharing a physical card
// with another currency sub-account, return the sibling (opposite currency).
// Returns null when no sibling exists — caller raises `missing_usd_sibling` or
// equivalent based on the parsed sheet's expectations.
async function loadSiblingAccount(
  userId: number,
  physicalCardId: string,
  excludeAccountId: number,
): Promise<TcAccount | null> {
  const [sibling] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      type: accounts.type,
      metadata: accounts.metadata,
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

function last4sOf(account: TcAccount): string[] {
  return Array.isArray(account.metadata?.last4s) ? account.metadata!.last4s : [];
}

function assertLast4Match(account: TcAccount, parsed: ParsedStatement) {
  const last4s = last4sOf(account);
  if (last4s.length > 0 && parsed.account.last4 && !last4s.includes(parsed.account.last4)) {
    throw new Error(`last4_mismatch:file=${parsed.account.last4},account=${last4s.join(",")}`);
  }
}

// Multi-sheet dispatch: resolves which ParsedStatement targets which account
// based on currency. Raises `missing_usd_sibling` / `missing_cop_sibling` when
// the xlsx carries a sheet whose currency has no linked account to consolidate
// into. Raises `currency_mismatch` when a single-sheet upload's currency does
// not match the account the user navigated to.
async function resolveDispatch(
  userId: number,
  originAccount: TcAccount,
  parsed: ParsedStatement[],
): Promise<{ account: TcAccount; parsed: ParsedStatement }[]> {
  if (parsed.length === 0) {
    throw new Error("no_sheets_parsed");
  }
  if (parsed.length === 1) {
    const only = parsed[0];
    if (only.account.currency !== originAccount.currency) {
      throw new Error(
        `currency_mismatch:file=${only.account.currency},account=${originAccount.currency}`,
      );
    }
    assertLast4Match(originAccount, only);
    return [{ account: originAccount, parsed: only }];
  }

  // Multi-sheet: need a sibling to absorb the other currency.
  if (!originAccount.physicalCardId) {
    throw new Error("multi_sheet_without_physical_card");
  }
  const sibling = await loadSiblingAccount(userId, originAccount.physicalCardId, originAccount.id);
  if (!sibling) {
    // Name the error by the missing currency so the UI can tell the user
    // exactly what's not linked.
    const originCurrencies = new Set(parsed.map((p) => p.account.currency));
    if (!originCurrencies.has(originAccount.currency)) {
      throw new Error("currency_mismatch:file_missing_account_currency");
    }
    const missing = parsed.map((p) => p.account.currency).find((c) => c !== originAccount.currency);
    throw new Error(`missing_${(missing ?? "usd").toLowerCase()}_sibling`);
  }
  if (sibling.institutionSlug !== "bancolombia") {
    throw new Error(`unsupported_sibling_institution:${sibling.institutionSlug}`);
  }

  const dispatches: { account: TcAccount; parsed: ParsedStatement }[] = [];
  for (const p of parsed) {
    let target: TcAccount | null = null;
    if (p.account.currency === originAccount.currency) target = originAccount;
    else if (p.account.currency === sibling.currency) target = sibling;
    if (!target) {
      throw new Error(
        `currency_mismatch:file=${p.account.currency},origin=${originAccount.currency},sibling=${sibling.currency}`,
      );
    }
    assertLast4Match(target, p);
    dispatches.push({ account: target, parsed: p });
  }
  return dispatches;
}

async function readUploadedBuffer(formData: FormData): Promise<Buffer> {
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("no_file");
  if (file.size === 0) throw new Error("empty_file");
  if (file.size > MAX_FILE_SIZE) throw new Error("file_too_large");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("unsupported_file_type");
  return Buffer.from(await file.arrayBuffer());
}

// Dry-run: parses the xlsx, runs matching against the ledger for each sheet,
// returns either a single ConsolidationReport (single-sheet xlsx) or a
// MultiConsolidationReport wrapping one report per sheet (multi-currency
// Mastercard/Amex internacionales). Already JSON-serializable (bigints
// serialized as strings) — safe to return to a client component.
export async function previewStatementAction(formData: FormData): Promise<ConsolidateActionResult> {
  const session = await getSessionUser();
  const { accountId, cycle } = inputSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
  });

  const origin = await loadTcAccount(session.id, accountId);
  const buffer = await readUploadedBuffer(formData);
  const parsedSheets = parseBancolombiaStatementAllSheets(buffer);
  const dispatch = await resolveDispatch(session.id, origin, parsedSheets);
  const fileHash = hashStatementBuffer(buffer);

  const reports: ConsolidationReport[] = [];
  for (const { account, parsed } of dispatch) {
    const r = await consolidateCycleFromStatement({
      userId: session.id,
      accountId: account.id,
      cycle,
      parsed,
      fileHash,
      dryRun: true,
    });
    reports.push(r);
  }

  log.info(
    {
      event: "statement_preview",
      userId: session.id,
      originAccountId: origin.id,
      cycle,
      sheetCount: parsedSheets.length,
      reports: reports.map((r) => ({
        accountId: r.accountId,
        matched: r.matchStats.matched,
        willChange: r.matchStats.matchedWillChange,
        inserted: r.matchStats.insertedMissing,
      })),
    },
    "statement preview computed",
  );

  return reports.length === 1 ? reports[0] : { kind: "multi", reports };
}

// Commit: re-parses the uploaded xlsx (we don't trust a client-side round-trip
// of the report), runs the full consolidation for each sheet sequentially, and
// revalidates the surfaces that render cycle state so the user immediately
// sees the "consolidated" badge without a manual refresh.
export async function commitStatementAction(formData: FormData): Promise<ConsolidateActionResult> {
  const session = await getSessionUser();
  const { accountId, cycle } = inputSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
  });

  const origin = await loadTcAccount(session.id, accountId);
  const buffer = await readUploadedBuffer(formData);
  const parsedSheets = parseBancolombiaStatementAllSheets(buffer);
  const dispatch = await resolveDispatch(session.id, origin, parsedSheets);
  const fileHash = hashStatementBuffer(buffer);

  const reports: ConsolidationReport[] = [];
  for (const { account, parsed } of dispatch) {
    const r = await consolidateCycleFromStatement({
      userId: session.id,
      accountId: account.id,
      cycle,
      parsed,
      fileHash,
      dryRun: false,
    });
    reports.push(r);
  }

  log.info(
    {
      event: "statement_commit",
      userId: session.id,
      originAccountId: origin.id,
      cycle,
      sheetCount: parsedSheets.length,
      reports: reports.map((r) => ({
        accountId: r.accountId,
        status: r.status,
        matched: r.matchStats.matched,
        willChange: r.matchStats.matchedWillChange,
        inserted: r.insertedTxIds.length,
        intereses: r.intereses.status,
        statementImportId: r.statementImportId,
      })),
    },
    `statement commit done (${reports.length} sheet${reports.length === 1 ? "" : "s"})`,
  );

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/settings/accounts");
  for (const r of reports) {
    revalidatePath(`/settings/accounts/${r.accountId}/consolidate/${cycle}`);
  }

  return reports.length === 1 ? reports[0] : { kind: "multi", reports };
}
