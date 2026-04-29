import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  ingestionLogs,
  transactions,
  type TelegramBatchItem,
  type TelegramDraft,
} from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { enqueueClassification } from "@/lib/classification/enqueue";
import { emit } from "@/lib/events/bus";
import { insertTransferGroup } from "@/lib/transactions/transfer-groups";

export type ConfirmResult =
  | { status: "inserted"; txId: number }
  | { status: "duplicated" }
  | { status: "error"; reason: string };

export function isDraftComplete(draft: TelegramDraft): boolean {
  return (
    typeof draft.amountCents === "string" &&
    draft.amountCents.length > 0 &&
    draft.currency != null &&
    draft.direction != null &&
    typeof draft.accountId === "number"
  );
}

export async function insertFromDraft(opts: {
  userId: number;
  draft: TelegramDraft;
  chatId: number;
  sourceMessageId?: number;
  externalIdOverride?: string;
}): Promise<ConfirmResult> {
  const { userId, draft, chatId, sourceMessageId, externalIdOverride } = opts;
  const startedAt = new Date();

  if (!isDraftComplete(draft)) {
    return { status: "error", reason: "draft is incomplete" };
  }

  const magnitude = BigInt(draft.amountCents as string);
  const signed = draft.direction === "income" ? magnitude : -magnitude;

  const descriptionRaw = draft.description ?? draft.merchant ?? "Telegram entry";
  const occurredAt = draft.occurredOn ? new Date(`${draft.occurredOn}T12:00:00-05:00`) : new Date();

  const externalId =
    externalIdOverride ?? (sourceMessageId ? `tg:${chatId}:${sourceMessageId}` : null);

  // #405: `draft.transfer` forces channel="transfer", category_slug=null, and
  // — when `destinationAccountId` is set — inserts a paired group atomically.
  // Category rules do not run for transfers (they're not spend/income).
  if (draft.transfer) {
    const outcome = await insertTransferFromDraft({
      userId,
      draft,
      signed,
      descriptionRaw,
      occurredAt,
      externalId,
      chatId,
      sourceMessageId,
      startedAt,
    });
    return outcome;
  }

  let categorySlug = draft.categorySlug ?? null;
  let classificationMethod: "rule" | "manual" | "unclassified" = categorySlug
    ? "manual"
    : "unclassified";
  let confidence: number | null = categorySlug ? 100 : null;

  if (!categorySlug) {
    const match = await classifyByRule(userId, {
      descriptionRaw,
      merchant: draft.merchant ?? null,
    });
    if (match) {
      categorySlug = match.categorySlug;
      classificationMethod = "rule";
      confidence = match.confidence;
    }
  }

  let outcome: ConfirmResult;
  try {
    const result = await db
      .insert(transactions)
      .values({
        userId,
        accountId: draft.accountId as number,
        occurredAt,
        amountCents: signed,
        currency: draft.currency as "COP" | "USD",
        descriptionRaw,
        descriptionClean: null,
        merchant: draft.merchant ?? null,
        categorySlug,
        counterpartyId: null,
        classificationMethod,
        classificationConfidence: confidence,
        source: "telegram",
        externalId,
        rawData: {
          source: "telegram",
          chatId,
          sourceMessageId,
          notes: draft.notes,
        },
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (result.length === 0) {
      outcome = { status: "duplicated" };
    } else {
      emit({
        type: "transaction:created",
        userId,
        id: result[0].id,
        source: "telegram",
        timestamp: Date.now(),
      });
      outcome = { status: "inserted", txId: result[0].id };
    }
  } catch (err) {
    outcome = { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }

  await db.insert(ingestionLogs).values({
    userId,
    source: "telegram",
    status: outcome.status,
    itemsReceived: 1,
    itemsInserted: outcome.status === "inserted" ? 1 : 0,
    itemsDuplicated: outcome.status === "duplicated" ? 1 : 0,
    errorMessage: outcome.status === "error" ? outcome.reason : null,
    payload: {
      chatId,
      sourceMessageId,
      draft: {
        amountCents: draft.amountCents,
        currency: draft.currency,
        direction: draft.direction,
        accountId: draft.accountId,
      },
    },
    startedAt,
    finishedAt: new Date(),
  });

  // #591: enqueue AI classification for txs the rule engine could not classify.
  // Transfers skip classification entirely (channel=transfer, no spend/income).
  if (outcome.status === "inserted" && classificationMethod === "unclassified") {
    await enqueueClassification(userId, [outcome.txId]);
  }

  return outcome;
}

// Branches off `insertFromDraft` when the draft is marked as a transfer.
// Factored out to keep the main path linear — the two flows share input
// validation and ingestion logging but nothing else.
async function insertTransferFromDraft(opts: {
  userId: number;
  draft: TelegramDraft;
  signed: bigint;
  descriptionRaw: string;
  occurredAt: Date;
  externalId: string | null;
  chatId: number;
  sourceMessageId?: number;
  startedAt: Date;
}): Promise<ConfirmResult> {
  const {
    userId,
    draft,
    signed,
    descriptionRaw,
    occurredAt,
    externalId,
    chatId,
    sourceMessageId,
    startedAt,
  } = opts;
  const accountId = draft.accountId as number;
  const currency = draft.currency as "COP" | "USD";
  const destinationAccountId = draft.transfer?.destinationAccountId;

  let outcome: ConfirmResult;
  if (typeof destinationAccountId === "number") {
    // Paired group: origin debit + destination credit. Origin leg carries the
    // sign from `direction`; the counter-leg flips it. tc_payment typical
    // flow: origin savings -X, destination TC +X.
    const result = await insertTransferGroup({
      userId,
      legs: [
        {
          accountId,
          amountCents: signed,
          currency,
          descriptionRaw,
          merchant: draft.merchant ?? null,
          source: "telegram",
          occurredAt,
          externalId,
          rawData: {
            source: "telegram",
            chatId,
            sourceMessageId,
            notes: draft.notes,
            role: signed < BigInt(0) ? "debit" : "credit",
          },
        },
        {
          accountId: destinationAccountId,
          amountCents: -signed,
          currency,
          descriptionRaw,
          merchant: draft.merchant ?? null,
          source: "telegram",
          occurredAt,
          externalId,
          rawData: {
            source: "telegram",
            chatId,
            sourceMessageId,
            notes: draft.notes,
            role: signed < BigInt(0) ? "credit" : "debit",
          },
        },
      ],
    });
    if (result.status === "duplicated") outcome = { status: "duplicated" };
    else if (result.status === "error") outcome = { status: "error", reason: result.reason };
    else {
      for (const txId of result.txIds) {
        emit({ type: "transaction:created", userId, id: txId, source: "telegram", timestamp: Date.now() });
      }
      outcome = { status: "inserted", txId: result.txIds[0] };
    }
  } else {
    // Unpaired single-leg transfer (tc_credit_received from the bot). The
    // counterpart is external; user can pair manually later from /transactions.
    try {
      const result = await db
        .insert(transactions)
        .values({
          userId,
          accountId,
          occurredAt,
          amountCents: signed,
          currency,
          descriptionRaw,
          descriptionClean: null,
          merchant: draft.merchant ?? null,
          categorySlug: null,
          counterpartyId: null,
          classificationMethod: "manual",
          classificationConfidence: null,
          source: "telegram",
          channel: "transfer",
          externalId,
          rawData: {
            source: "telegram",
            chatId,
            sourceMessageId,
            notes: draft.notes,
          },
        })
        .onConflictDoNothing({
          target: [transactions.accountId, transactions.externalId],
          where: sql`${transactions.externalId} IS NOT NULL`,
        })
        .returning({ id: transactions.id });

      if (result.length === 0) {
        outcome = { status: "duplicated" };
      } else {
        emit({
          type: "transaction:created",
          userId,
          id: result[0].id,
          source: "telegram",
          timestamp: Date.now(),
        });
        outcome = { status: "inserted", txId: result[0].id };
      }
    } catch (err) {
      outcome = { status: "error", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  await db.insert(ingestionLogs).values({
    userId,
    source: "telegram",
    status: outcome.status,
    itemsReceived: 1,
    itemsInserted: outcome.status === "inserted" ? 1 : 0,
    itemsDuplicated: outcome.status === "duplicated" ? 1 : 0,
    errorMessage: outcome.status === "error" ? outcome.reason : null,
    payload: {
      chatId,
      sourceMessageId,
      draft: {
        amountCents: draft.amountCents,
        currency: draft.currency,
        direction: draft.direction,
        accountId: draft.accountId,
      },
      transfer: {
        destinationAccountId: destinationAccountId ?? null,
      },
    },
    startedAt,
    finishedAt: new Date(),
  });

  return outcome;
}

export type BatchResult = {
  inserted: number[];
  duplicated: number;
  errors: string[];
};

export async function insertBatch(opts: {
  userId: number;
  items: TelegramBatchItem[];
  chatId: number;
}): Promise<BatchResult> {
  const { userId, items, chatId } = opts;
  const result: BatchResult = { inserted: [], duplicated: 0, errors: [] };

  for (const item of items) {
    const outcome = await insertFromDraft({
      userId,
      draft: item.draft,
      chatId,
      externalIdOverride: item.externalId,
    });
    if (outcome.status === "inserted") result.inserted.push(outcome.txId);
    else if (outcome.status === "duplicated") result.duplicated += 1;
    else result.errors.push(outcome.reason);
  }

  return result;
}
