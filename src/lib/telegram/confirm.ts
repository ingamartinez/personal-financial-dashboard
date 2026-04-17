import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions, type TelegramDraft } from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";

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
  draft: TelegramDraft;
  chatId: number;
  sourceMessageId?: number;
}): Promise<ConfirmResult> {
  const { draft, chatId, sourceMessageId } = opts;

  if (!isDraftComplete(draft)) {
    return { status: "error", reason: "draft is incomplete" };
  }

  const magnitude = BigInt(draft.amountCents as string);
  const signed = draft.direction === "income" ? magnitude : -magnitude;

  const descriptionRaw = draft.description ?? draft.merchant ?? "Telegram entry";
  const occurredAt = draft.occurredOn ? new Date(`${draft.occurredOn}T12:00:00-05:00`) : new Date();

  let categorySlug = draft.categorySlug ?? null;
  let classificationMethod: "rule" | "manual" | "unclassified" = categorySlug
    ? "manual"
    : "unclassified";
  let confidence: number | null = categorySlug ? 100 : null;

  if (!categorySlug) {
    const match = await classifyByRule({
      descriptionRaw,
      merchant: draft.merchant ?? null,
    });
    if (match) {
      categorySlug = match.categorySlug;
      classificationMethod = "rule";
      confidence = match.confidence;
    }
  }

  const externalId = sourceMessageId ? `tg:${chatId}:${sourceMessageId}` : null;

  try {
    const result = await db
      .insert(transactions)
      .values({
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

    if (result.length === 0) return { status: "duplicated" };

    emit({
      type: "transaction:created",
      id: result[0].id,
      source: "telegram",
      timestamp: Date.now(),
    });
    return { status: "inserted", txId: result[0].id };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
