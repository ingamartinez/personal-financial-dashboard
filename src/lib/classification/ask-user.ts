// #814 Phase 4 — ask the user via Telegram when an opaque-gateway row has
// zero correlation candidates. Last resort after Phases 2 and 3.
//
// Population: classification_reason.action=abstained AND reason=opaque_gateway.
// Transfer-pair abstains and swept rows are out of scope.
//
// Sending happens HERE, never inside the sweep loop. The sweep/pipeline only
// enqueue a classify-ask job. At most one outstanding question per user.
//
// Idempotency lives on classification_reason.action=awaiting_user (plus
// askedAt). The 24h telegram conversation is a reply interceptor, not
// asked-state — a draft or disambiguation push will clobber the step.
// The telegram_sessions ROW is the channel; clearing/expiring the
// conversation must not delete it or the next ask dies on no_channel.
//
// Unanswered questions expire back to plain abstained and become re-askable.
// Evidence arrives late in this system; a row pinned awaiting_user forever
// would never be re-correlated once its receipt lands.
//
// Do NOT key opaque no-evidence prior art on the bank/gateway string. Two
// MERCADOPAGO COLOMBIA charges are not the same merchant.

import { and, asc, count, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  categories,
  classificationCorrections,
  transactions,
  users,
  type ClassificationReasonJson,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { enqueueClassification } from "@/lib/classification/enqueue";
import { loadTxEvidence } from "@/lib/classification/evidence";
import { matchOpaqueGateway } from "@/lib/classification/opaque-gateways";
import {
  ABSTAINED_ACTION,
  AWAITING_USER_ACTION,
  abstainReason,
  asReason,
  awaitingUserReason,
  isAwaitingUser,
  isOpaqueAbstained,
  manualReason,
} from "@/lib/classification/reason";
import { SYSTEM_OWNED_CATEGORY_SLUGS } from "@/lib/classification/ai";
import { getLatestSessionByUserId, upsertSession } from "@/lib/telegram/session";
import { pushToUser } from "@/lib/telegram/push";
import { askCategoriesKeyboard } from "@/lib/telegram/keyboard";
import { renderClassificationQuestion } from "@/lib/telegram/formatter";
import type { NluCategoryOption } from "@/lib/ai/transaction-nlu";

const log = createLogger({ module: "classification/ask-user" });

export const ASK_TTL_MS = 24 * 60 * 60 * 1000;
export const ASK_CATEGORY_LIMIT = 8;
const MAX_CONSIDER_PER_RUN = 20;

const SESSION_BLOCKS_ASK = new Set([
  "awaiting_account",
  "awaiting_amount",
  "awaiting_category",
  "awaiting_confirm",
  "awaiting_photo_account",
  "awaiting_batch_confirm",
  "awaiting_backfill_confirm",
  "backfill_running",
  "awaiting_disambiguation",
  "awaiting_classification",
]);

export type AskSkipReason =
  "no_eligible" | "outstanding" | "session_open" | "no_channel" | "send_failed" | "no_categories";

export type AskUserResult = {
  askedTxId: number | null;
  skipped: AskSkipReason | null;
  expiredCount: number;
  requeuedCount: number;
};

type EligibleTx = {
  id: number;
  descriptionRaw: string;
  merchant: string | null;
  amountCents: bigint;
  currency: "COP" | "USD";
  occurredAt: Date;
  classificationReason: ClassificationReasonJson | null;
};

function opaqueAbstainedClause(userId: number) {
  return and(
    eq(transactions.userId, userId),
    notDeleted(transactions.deletedAt),
    sql`${transactions.classificationReason}->>'action' = ${ABSTAINED_ACTION}`,
    sql`${transactions.classificationReason}->>'reason' = ${"opaque_gateway"}`,
  );
}

function awaitingUserClause(userId: number) {
  return and(
    eq(transactions.userId, userId),
    notDeleted(transactions.deletedAt),
    sql`${transactions.classificationReason}->>'action' = ${AWAITING_USER_ACTION}`,
  );
}

function askedAtMs(reason: ClassificationReasonJson | null): number | null {
  if (!reason?.askedAt) return null;
  const ms = Date.parse(reason.askedAt);
  return Number.isFinite(ms) ? ms : null;
}

export async function expireStaleAsks(userId: number, now = Date.now()): Promise<number> {
  const rows = await db
    .select({
      id: transactions.id,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(awaitingUserClause(userId));

  let expired = 0;
  for (const row of rows) {
    const reason = asReason(row.classificationReason);
    const at = askedAtMs(reason);
    if (at != null && now - at < ASK_TTL_MS) continue;
    const gateway = typeof reason?.gateway === "string" ? reason.gateway : "unknown";
    const offered = Array.isArray(reason?.offered)
      ? reason.offered.filter((s): s is string => typeof s === "string")
      : undefined;
    await db
      .update(transactions)
      .set({
        classificationReason: {
          ...abstainReason("opaque_gateway", { gateway }),
          ...(offered && offered.length > 0 ? { offered } : {}),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, row.id)));
    expired++;
    log.info(
      { userId, txId: row.id, event: "classify_ask_expired" },
      "awaiting_user ask expired back to abstained",
    );
  }
  return expired;
}

async function hasOutstandingAsk(userId: number, now = Date.now()): Promise<boolean> {
  const rows = await db
    .select({
      id: transactions.id,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(awaitingUserClause(userId))
    .limit(1);
  const reason = asReason(rows[0]?.classificationReason ?? null);
  const at = askedAtMs(reason);
  if (!rows[0]) return false;
  if (at == null) return false;
  return now - at < ASK_TTL_MS;
}

async function loadEligible(userId: number): Promise<EligibleTx[]> {
  return db
    .select({
      id: transactions.id,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(opaqueAbstainedClause(userId))
    .orderBy(desc(transactions.occurredAt), asc(transactions.id))
    .limit(MAX_CONSIDER_PER_RUN);
}

/**
 * Leaf categories the user actually uses, falling back to seed order.
 * System-owned slugs and `otros` are never offered — guessing those is how
 * a "I don't know" click would re-poison the bucket.
 */
export async function pickOfferedCategories(userId: number): Promise<NluCategoryOption[]> {
  const usage = db
    .select({
      slug: transactions.categorySlug,
      n: count(transactions.id).as("n"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        isNotNull(transactions.categorySlug),
      ),
    )
    .groupBy(transactions.categorySlug)
    .as("usage");

  const rows = await db
    .select({
      slug: categories.slug,
      name: categories.name,
      parentSlug: categories.parentSlug,
      usage: usage.n,
    })
    .from(categories)
    .leftJoin(usage, and(eq(usage.slug, categories.slug)))
    .where(
      and(
        eq(categories.userId, userId),
        notDeleted(categories.deletedAt),
        isNotNull(categories.parentSlug),
        ne(categories.slug, "otros"),
      ),
    )
    .orderBy(sql`COALESCE(${usage.n}, 0) DESC`, asc(categories.sortOrder), asc(categories.name));

  const out: NluCategoryOption[] = [];
  for (const row of rows) {
    if (SYSTEM_OWNED_CATEGORY_SLUGS.has(row.slug)) continue;
    out.push({ slug: row.slug, name: row.name, parentSlug: row.parentSlug });
    if (out.length >= ASK_CATEGORY_LIMIT) break;
  }
  return out;
}

async function resetToUnclassified(userId: number, txId: number): Promise<void> {
  await db
    .update(transactions)
    .set({
      categorySlug: null,
      classificationMethod: "unclassified",
      classificationConfidence: null,
      classificationReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, userId), eq(transactions.id, txId)));
}

async function requeueIfEvidence(
  userId: number,
  rows: EligibleTx[],
): Promise<{ remaining: EligibleTx[]; requeuedCount: number }> {
  const remaining: EligibleTx[] = [];
  const requeued: number[] = [];
  for (const row of rows) {
    const evidence = await loadTxEvidence(userId, {
      id: row.id,
      descriptionRaw: row.descriptionRaw,
      merchant: row.merchant,
    });
    if (evidence.candidates.length === 0) {
      remaining.push(row);
      continue;
    }
    await resetToUnclassified(userId, row.id);
    requeued.push(row.id);
    log.info(
      {
        userId,
        txId: row.id,
        candidateCount: evidence.candidates.length,
        event: "classify_ask_requeued_with_evidence",
      },
      "opaque abstain now has correlation candidates — requeued for classification",
    );
  }
  if (requeued.length > 0) {
    await enqueueClassification(userId, requeued);
  }
  return { remaining, requeuedCount: requeued.length };
}

function sessionBlocksAsk(step: string | undefined): boolean {
  if (!step) return false;
  return SESSION_BLOCKS_ASK.has(step);
}

export async function processAskForUser(userId: number, now = Date.now()): Promise<AskUserResult> {
  const expiredCount = await expireStaleAsks(userId, now);

  const eligible = await loadEligible(userId);
  const { remaining, requeuedCount } = await requeueIfEvidence(userId, eligible);

  if (await hasOutstandingAsk(userId, now)) {
    return { askedTxId: null, skipped: "outstanding", expiredCount, requeuedCount };
  }

  if (remaining.length === 0) {
    return { askedTxId: null, skipped: "no_eligible", expiredCount, requeuedCount };
  }

  const sessionRow = await getLatestSessionByUserId(userId);
  if (!sessionRow) {
    return { askedTxId: null, skipped: "no_channel", expiredCount, requeuedCount };
  }
  if (sessionBlocksAsk(sessionRow.state?.step)) {
    log.info(
      { userId, step: sessionRow.state?.step, event: "classify_ask_skipped_session_open" },
      "classify-ask skipped — session already open",
    );
    return { askedTxId: null, skipped: "session_open", expiredCount, requeuedCount };
  }

  const offered = await pickOfferedCategories(userId);
  if (offered.length === 0) {
    log.warn({ userId, event: "classify_ask_no_categories" }, "no leaf categories to offer");
    return { askedTxId: null, skipped: "no_categories", expiredCount, requeuedCount };
  }

  const tx = remaining[0]!;
  const reason = asReason(tx.classificationReason);
  const gateway =
    typeof reason?.gateway === "string"
      ? reason.gateway
      : (matchOpaqueGateway([tx.descriptionRaw, tx.merchant]) ?? "unknown");

  const stamped = await db
    .update(transactions)
    .set({
      classificationReason: awaitingUserReason({
        gateway,
        offered: offered.map((c) => c.slug),
      }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, tx.id),
        sql`${transactions.classificationReason}->>'action' = ${ABSTAINED_ACTION}`,
        sql`${transactions.classificationReason}->>'reason' = ${"opaque_gateway"}`,
      ),
    )
    .returning({ id: transactions.id });

  if (stamped.length === 0) {
    return { askedTxId: null, skipped: "outstanding", expiredCount, requeuedCount };
  }

  const text = renderClassificationQuestion({
    descriptionRaw: tx.descriptionRaw,
    amountCents: tx.amountCents,
    currency: tx.currency,
    occurredAt: tx.occurredAt,
  });
  const result = await pushToUser(userId, text, undefined, askCategoriesKeyboard(tx.id, offered));

  if (!result.ok) {
    await db
      .update(transactions)
      .set({
        classificationReason: abstainReason("opaque_gateway", { gateway }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, tx.id),
          sql`${transactions.classificationReason}->>'action' = ${AWAITING_USER_ACTION}`,
        ),
      );
    log.info(
      { userId, txId: tx.id, reason: result.reason, event: "classify_ask_send_failed" },
      "classify-ask stamp reverted — Telegram send failed",
    );
    return { askedTxId: null, skipped: "send_failed", expiredCount, requeuedCount };
  }

  const chatId = Number(sessionRow.chatId);
  const telegramUserId = Number(sessionRow.telegramUserId);
  await upsertSession({
    chatId,
    userId,
    telegramUserId,
    state: {
      step: "awaiting_classification",
      draft: {},
      sourceChatId: chatId,
      classificationTxId: tx.id,
    },
    ttlMs: ASK_TTL_MS,
  });

  log.info({ userId, txId: tx.id, event: "classify_ask_sent" }, "classify-ask question sent");
  return { askedTxId: tx.id, skipped: null, expiredCount, requeuedCount };
}

export async function listActiveAskUserIds(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ userId: transactions.userId })
    .from(transactions)
    .innerJoin(users, and(eq(users.id, transactions.userId), eq(users.active, true)))
    .where(
      and(
        notDeleted(transactions.deletedAt),
        sql`(
          ${transactions.classificationReason}->>'action' = ${AWAITING_USER_ACTION}
          OR (
            ${transactions.classificationReason}->>'action' = ${ABSTAINED_ACTION}
            AND ${transactions.classificationReason}->>'reason' = ${"opaque_gateway"}
          )
        )`,
      ),
    );
  return rows.map((r) => r.userId);
}

export type ApplyAnswerResult =
  | { ok: true; categorySlug: string }
  | { ok: false; reason: "not_found" | "invalid_category" | "not_askable" };

async function loadAskableTx(
  userId: number,
  txId: number,
): Promise<{
  id: number;
  categorySlug: string | null;
  merchant: string | null;
  descriptionRaw: string;
  classificationReason: ClassificationReasonJson | null;
} | null> {
  const [row] = await db
    .select({
      id: transactions.id,
      categorySlug: transactions.categorySlug,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, txId),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

function offeredSlugs(reason: ClassificationReasonJson | null): string[] {
  if (!Array.isArray(reason?.offered)) return [];
  return reason.offered.filter((s): s is string => typeof s === "string");
}

/**
 * Apply a Telegram (or equivalent) answer. Replaces classification_reason so
 * an abstained MercadoPago row does not keep its old payload. Does not write
 * merchant_hints — opaque gateway strings are not a merchant.
 */
export async function applyClassificationAnswer(opts: {
  userId: number;
  txId: number;
  categorySlug: string;
}): Promise<ApplyAnswerResult> {
  const { userId, txId, categorySlug } = opts;
  const row = await loadAskableTx(userId, txId);
  if (!row) return { ok: false, reason: "not_found" };

  const reason = asReason(row.classificationReason);
  if (!isAwaitingUser(reason) && !isOpaqueAbstained(reason)) {
    return { ok: false, reason: "not_askable" };
  }

  const [cat] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.slug, categorySlug),
        notDeleted(categories.deletedAt),
      ),
    )
    .limit(1);
  if (!cat) return { ok: false, reason: "invalid_category" };

  const prior = row.categorySlug;
  const isChange = prior !== categorySlug;

  await db.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({
        categorySlug,
        classificationMethod: "manual",
        classificationConfidence: 100,
        classificationReason: manualReason(reason, { via: "telegram" }),
        ...(isChange ? { previousCategorySlug: prior } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, txId)));

    if (isChange) {
      const opaque = matchOpaqueGateway([row.merchant, row.descriptionRaw]);
      await trx.insert(classificationCorrections).values({
        userId,
        transactionId: txId,
        merchant: opaque ? null : row.merchant,
        previousCategorySlug: prior,
        newCategorySlug: categorySlug,
      });
    }
  });

  log.info(
    { userId, txId, categorySlug, event: "classify_ask_answered" },
    "classify-ask answer applied",
  );
  return { ok: true, categorySlug };
}

export async function applyClassificationAnswerByIndex(opts: {
  userId: number;
  txId: number;
  index: number;
}): Promise<ApplyAnswerResult> {
  const row = await loadAskableTx(opts.userId, opts.txId);
  if (!row) return { ok: false, reason: "not_found" };
  const slugs = offeredSlugs(asReason(row.classificationReason));
  const slug = slugs[opts.index];
  if (!slug) return { ok: false, reason: "invalid_category" };
  return applyClassificationAnswer({
    userId: opts.userId,
    txId: opts.txId,
    categorySlug: slug,
  });
}

export async function skipClassificationQuestion(opts: {
  userId: number;
  txId: number;
}): Promise<{ ok: boolean }> {
  const { userId, txId } = opts;
  const row = await loadAskableTx(userId, txId);
  if (!row) return { ok: false };
  const reason = asReason(row.classificationReason);
  if (!isAwaitingUser(reason)) return { ok: true };

  const gateway = typeof reason?.gateway === "string" ? reason.gateway : "unknown";
  const offered = offeredSlugs(reason);
  await db
    .update(transactions)
    .set({
      classificationReason: {
        ...abstainReason("opaque_gateway", { gateway }),
        ...(offered.length > 0 ? { offered } : {}),
      },
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, userId), eq(transactions.id, txId)));
  log.info({ userId, txId, event: "classify_ask_skipped" }, "classify-ask skipped by user");
  return { ok: true };
}

export function offeredSlugsFromReason(reason: ClassificationReasonJson | null): string[] {
  return offeredSlugs(reason);
}
