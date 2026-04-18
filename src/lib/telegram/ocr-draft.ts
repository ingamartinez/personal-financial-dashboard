import type { AccountDetail } from "@/lib/accounts/queries";
import type { TelegramBatchItem, TelegramDraft } from "@/lib/db/schema";
import type { OcrParsedRow } from "@/lib/ingestion/ocr";

/**
 * Maps an OCR-extracted row to a TelegramDraft ready for the confirm flow.
 * OCR returns signed amounts (positive=income, negative=expense); we strip
 * the sign and set `direction` accordingly. Currency follows the account.
 */
export function buildDraftFromOcrRow(row: OcrParsedRow, account: AccountDetail): TelegramBatchItem {
  const direction: "expense" | "income" = row.amountCents < BigInt(0) ? "expense" : "income";
  const magnitude = row.amountCents < BigInt(0) ? -row.amountCents : row.amountCents;

  const draft: TelegramDraft = {
    amountCents: magnitude.toString(),
    currency: account.currency,
    direction,
    merchant: row.description,
    description: row.description,
    occurredOn: row.occurredOn,
    accountId: account.id,
  };

  return {
    draft,
    externalId: row.externalId,
  };
}
