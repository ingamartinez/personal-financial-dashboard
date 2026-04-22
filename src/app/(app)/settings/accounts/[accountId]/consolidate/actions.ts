"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
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
import { parseBancolombiaStatement } from "@/lib/ingestion/bancolombia-statement/xlsx";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "consolidate-actions" });

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const inputSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  cycle: z.string().regex(/^\d{4}-\d{2}$/, "cycle must be YYYY-MM"),
});

async function loadTcAccount(userId: number, accountId: number) {
  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      type: accounts.type,
      metadata: accounts.metadata,
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

async function readUploadedBuffer(formData: FormData): Promise<Buffer> {
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("no_file");
  if (file.size === 0) throw new Error("empty_file");
  if (file.size > MAX_FILE_SIZE) throw new Error("file_too_large");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("unsupported_file_type");
  return Buffer.from(await file.arrayBuffer());
}

// Dry-run: parses the xlsx, runs matching against the ledger, returns a
// ConsolidationReport without writing to the DB. The report is already
// JSON-serializable (bigints serialized as strings) — safe to return to
// a client component.
export async function previewStatementAction(formData: FormData): Promise<ConsolidationReport> {
  const session = await getSessionUser();
  const { accountId, cycle } = inputSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
  });

  const account = await loadTcAccount(session.id, accountId);
  const buffer = await readUploadedBuffer(formData);
  const parsed = parseBancolombiaStatement(buffer);

  if (parsed.account.last4) {
    const last4s = Array.isArray(account.metadata?.last4s) ? account.metadata!.last4s : [];
    if (last4s.length > 0 && !last4s.includes(parsed.account.last4)) {
      throw new Error(`last4_mismatch:file=${parsed.account.last4},account=${last4s.join(",")}`);
    }
  }

  const fileHash = hashStatementBuffer(buffer);
  const report = await consolidateCycleFromStatement({
    userId: session.id,
    accountId: account.id,
    cycle,
    parsed,
    fileHash,
    dryRun: true,
  });

  log.info(
    {
      event: "statement_preview",
      userId: session.id,
      accountId: account.id,
      cycle,
      matched: report.matchStats.matched,
      willChange: report.matchStats.matchedWillChange,
      inserted: report.matchStats.insertedMissing,
    },
    "statement preview computed",
  );

  return report;
}

// Commit: re-parses the uploaded xlsx (we don't trust a client-side round-trip
// of the report), runs the full consolidation, and revalidates the surfaces
// that render cycle state so the user immediately sees the "consolidated"
// badge without a manual refresh.
export async function commitStatementAction(formData: FormData): Promise<ConsolidationReport> {
  const session = await getSessionUser();
  const { accountId, cycle } = inputSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
  });

  const account = await loadTcAccount(session.id, accountId);
  const buffer = await readUploadedBuffer(formData);
  const parsed = parseBancolombiaStatement(buffer);
  const fileHash = hashStatementBuffer(buffer);

  const report = await consolidateCycleFromStatement({
    userId: session.id,
    accountId: account.id,
    cycle,
    parsed,
    fileHash,
    dryRun: false,
  });

  log.info(
    {
      event: "statement_commit",
      userId: session.id,
      accountId: account.id,
      cycle,
      status: report.status,
      matched: report.matchStats.matched,
      willChange: report.matchStats.matchedWillChange,
      inserted: report.insertedTxIds.length,
      intereses: report.intereses.status,
      statementImportId: report.statementImportId,
    },
    `statement commit: ${report.status}`,
  );

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/settings/accounts");
  revalidatePath(`/settings/accounts/${account.id}/consolidate/${cycle}`);

  return report;
}
