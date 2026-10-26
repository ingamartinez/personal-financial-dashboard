import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { parseArqEmail } from "./parsers/arq";
import { ingestArqEmail } from "@/lib/ingestion/email-arq";

// ---------------------------------------------------------------------------
// ARQ reparse (#1015)
//
// ARQ receipts that the parser could not handle are persisted as
// match_status='unmatched' with parsed_payload.error.reason (see
// markReceiptNeedsReview). Extending the parser does NOT by itself recover
// them: the cron only picks up match_status='pending'. This module re-runs the
// current parser over exactly those receipts, first as a read-only plan
// (`planArqReparse`) and then, on demand, through the normal ingestion path
// (`reparseArqReceipts`).
//
// Deliberately NOT the reset-to-pending route used by the Mercado Pago backfill:
// flipping a batch to 'pending' hands unrelated receipts to the next cron tick
// and leaves a window where a failed parse is invisible. Here every receipt is
// ingested directly, one at a time, and the outcome is reported per receipt.
//
// Nothing is guessed: a receipt is rewritten only when the current parser
// returns `parsed`.
// ---------------------------------------------------------------------------

const log = createLogger({ module: "gmail/reparse-arq" });

export type ArqReparseCandidate = {
  receiptId: number;
  userId: number;
  emailReceivedAt: Date | null;
  /** `parsed`: the current parser handles it. `still_unparsed`: it does not. */
  outcome: "parsed" | "still_unparsed";
  /** Parser reason for `still_unparsed`, null when parsed. */
  reason: string | null;
  /** USDc cents as a string (bigint-safe); null when still_unparsed. */
  amountUsdcCents: string | null;
  counterpartyName: string | null;
  copAmountCents: string | null;
  impliedTrmCopPerUsdc: number | null;
};

export type ArqReparsePlan = {
  candidates: ArqReparseCandidate[];
  /** Receipts the current parser can now turn into a transaction. */
  eligible: ArqReparseCandidate[];
  parsed: number;
  stillUnparsed: number;
};

export type ArqReparseFailure = {
  receiptId: number;
  userId: number;
  status: string;
  reason: string;
};

export type ArqReparseReport = {
  considered: number;
  attempted: number;
  matched: number;
  failed: number;
  failures: ArqReparseFailure[];
};

const REPARSEABLE_STATUSES = ["pending", "unmatched"] as const;

function reparseableWhere(userId?: number) {
  const conditions = [
    eq(emailReceipts.gateway, "arq"),
    inArray(emailReceipts.matchStatus, REPARSEABLE_STATUSES),
    notDeleted(emailReceipts.deletedAt),
  ];
  if (userId !== undefined) conditions.push(eq(emailReceipts.userId, userId));
  return and(...conditions);
}

/**
 * Read-only pass: run the current parser over every ARQ receipt that is not
 * matched yet, and report what each one would become. Writes nothing.
 *
 * This is what the `--dry-run` flag of the backfill script prints, and it is the
 * answer to "what did the parser fix actually recover?" before anything lands.
 */
export async function planArqReparse(opts?: { userId?: number }): Promise<ArqReparsePlan> {
  const rows = await db
    .select({
      id: emailReceipts.id,
      userId: emailReceipts.userId,
      rawHtml: emailReceipts.rawHtml,
      emailReceivedAt: emailReceipts.emailReceivedAt,
      createdAt: emailReceipts.createdAt,
    })
    .from(emailReceipts)
    .where(reparseableWhere(opts?.userId))
    .orderBy(emailReceipts.id);

  const candidates: ArqReparseCandidate[] = rows.map((row) => {
    // Prefer the Gmail-supplied timestamp (#545); fall back to createdAt for
    // receipts ingested before that column existed.
    const receivedAt = row.emailReceivedAt ?? row.createdAt;
    const parsed = parseArqEmail(row.rawHtml, { occurredAt: receivedAt });

    const base = {
      receiptId: row.id,
      userId: row.userId,
      emailReceivedAt: row.emailReceivedAt,
    };

    if (parsed.kind === "parsed") {
      return {
        ...base,
        outcome: "parsed" as const,
        reason: null,
        amountUsdcCents: parsed.amountUsdcCents.toString(),
        counterpartyName: parsed.counterpartyName,
        copAmountCents: parsed.copAmountCents?.toString() ?? null,
        impliedTrmCopPerUsdc: parsed.impliedTrmCopPerUsdc,
      };
    }

    return {
      ...base,
      outcome: "still_unparsed" as const,
      reason: parsed.reason,
      amountUsdcCents: null,
      counterpartyName: null,
      copAmountCents: null,
      impliedTrmCopPerUsdc: null,
    };
  });

  const eligible = candidates.filter((candidate) => candidate.outcome === "parsed");
  log.info(
    {
      userId: opts?.userId ?? null,
      considered: candidates.length,
      parsed: eligible.length,
      event: "arq_reparse_planned",
    },
    "planned ARQ receipt reparse",
  );

  return {
    candidates,
    eligible,
    parsed: eligible.length,
    stillUnparsed: candidates.length - eligible.length,
  };
}

/**
 * Apply the plan: re-ingest every receipt the current parser can now handle
 * through the same path the cron uses. Nothing matched is touched, and a
 * receipt the parser still cannot read keeps its recorded failure.
 */
export async function reparseArqReceipts(opts?: { userId?: number }): Promise<ArqReparseReport> {
  const plan = await planArqReparse(opts);
  const report: ArqReparseReport = {
    considered: plan.candidates.length,
    attempted: 0,
    matched: 0,
    failed: 0,
    failures: [],
  };
  if (plan.eligible.length === 0) return report;

  const eligibleIds = plan.eligible.map((candidate) => candidate.receiptId);
  const rows = await db
    .select({
      id: emailReceipts.id,
      userId: emailReceipts.userId,
      rawHtml: emailReceipts.rawHtml,
      emailReceivedAt: emailReceipts.emailReceivedAt,
      createdAt: emailReceipts.createdAt,
    })
    .from(emailReceipts)
    .where(inArray(emailReceipts.id, eligibleIds))
    // Deterministic order: ingest in receipt order so a report reads the same
    // way twice and a partial run leaves a predictable prefix behind.
    .orderBy(emailReceipts.id);

  for (const row of rows) {
    report.attempted += 1;
    const outcome = await ingestArqEmail(
      row.userId,
      row.id,
      row.rawHtml,
      row.emailReceivedAt ?? row.createdAt,
    );

    if (outcome.status === "inserted" || outcome.status === "duplicated") {
      report.matched += 1;
      log.info(
        {
          userId: row.userId,
          receiptId: row.id,
          status: outcome.status,
          txId: outcome.status === "inserted" ? outcome.txId : null,
          event: "arq_reparse_receipt_ingested",
        },
        "reparsed ARQ receipt into a transaction",
      );
      continue;
    }

    report.failed += 1;
    report.failures.push({
      receiptId: row.id,
      userId: row.userId,
      status: outcome.status,
      reason: outcome.reason,
    });
    log.warn(
      {
        userId: row.userId,
        receiptId: row.id,
        status: outcome.status,
        reason: outcome.reason,
        event: "arq_reparse_receipt_failed",
      },
      "reparsed ARQ receipt did not become a transaction",
    );
  }

  log.info(
    { userId: opts?.userId ?? null, ...report, event: "arq_reparse_done" },
    "finished reparsing ARQ receipts",
  );
  return report;
}
