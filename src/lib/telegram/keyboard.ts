import type { InlineKeyboardMarkup } from "@/lib/telegram/types";
import type { NluAccountOption, NluCategoryOption } from "@/lib/ai/transaction-nlu";
import { formatAccountLabel } from "@/lib/accounts/format";

export const CALLBACK = {
  CONFIRM: "c",
  CANCEL: "x",
  EDIT_ACCOUNT: "ea",
  EDIT_CATEGORY: "ec",
  ACCOUNT_PREFIX: "a:",
  CATEGORY_PREFIX: "k:",
  BACK: "b",
  BATCH_CONFIRM: "bc",
  /** #814 Phase 4 — `cq:{txId}:{index}` or `cq:{txId}:s`. Bound to an existing tx. */
  ASK_PREFIX: "cq:",
  ASK_SKIP: "s",
} as const;

export type AskCallback =
  { txId: number; kind: "category"; index: number } | { txId: number; kind: "skip" };

export function askCategoryCallback(txId: number, index: number): string {
  return `${CALLBACK.ASK_PREFIX}${txId}:${index}`;
}

export function askSkipCallback(txId: number): string {
  return `${CALLBACK.ASK_PREFIX}${txId}:${CALLBACK.ASK_SKIP}`;
}

export function parseAskCallback(data: string): AskCallback | null {
  if (!data.startsWith(CALLBACK.ASK_PREFIX)) return null;
  const rest = data.slice(CALLBACK.ASK_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const txId = Number(rest.slice(0, sep));
  const token = rest.slice(sep + 1);
  if (!Number.isInteger(txId) || txId <= 0) return null;
  if (token === CALLBACK.ASK_SKIP) return { txId, kind: "skip" };
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0) return null;
  return { txId, kind: "category", index };
}

export function confirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: CALLBACK.CONFIRM },
        { text: "❌ Cancelar", callback_data: CALLBACK.CANCEL },
      ],
      [
        { text: "✏️ Cuenta", callback_data: CALLBACK.EDIT_ACCOUNT },
        { text: "✏️ Categoría", callback_data: CALLBACK.EDIT_CATEGORY },
      ],
    ],
  };
}

export function accountsKeyboard(accounts: NluAccountOption[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const a of accounts) {
    rows.push([
      {
        text: formatAccountLabel(a, { withLast4: true }),
        callback_data: `${CALLBACK.ACCOUNT_PREFIX}${a.id}`,
      },
    ]);
  }
  rows.push([{ text: "⬅️ Volver", callback_data: CALLBACK.BACK }]);
  return { inline_keyboard: rows };
}

export function batchConfirmKeyboard(count: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: `✅ Confirmar (${count})`, callback_data: CALLBACK.BATCH_CONFIRM },
        { text: "❌ Cancelar", callback_data: CALLBACK.CANCEL },
      ],
    ],
  };
}

export function categoriesKeyboard(
  categories: NluCategoryOption[],
  opts: { limit?: number } = {},
): InlineKeyboardMarkup {
  const limit = opts.limit ?? 10;
  const slice = categories.slice(0, limit);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = slice.slice(i, i + 2).map((c) => ({
      text: c.name,
      callback_data: `${CALLBACK.CATEGORY_PREFIX}${c.slug}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "⬅️ Volver", callback_data: CALLBACK.BACK }]);
  return { inline_keyboard: rows };
}

/**
 * Category buttons for an existing transaction (#814 Phase 4).
 * Distinct from `categoriesKeyboard` (`k:{slug}`), which only patches a
 * new-tx draft. Callback carries txId so the answer survives a clobbered session.
 */
export function askCategoriesKeyboard(
  txId: number,
  categories: NluCategoryOption[],
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = categories.slice(i, i + 2).map((c, offset) => ({
      text: c.name,
      callback_data: askCategoryCallback(txId, i + offset),
    }));
    rows.push(row);
  }
  rows.push([{ text: "Ahora no", callback_data: askSkipCallback(txId) }]);
  return { inline_keyboard: rows };
}
