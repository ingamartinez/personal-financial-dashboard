import type { InlineKeyboardMarkup } from "@/lib/telegram/types";
import type { NluAccountOption, NluCategoryOption } from "@/lib/ai/transaction-nlu";

export const CALLBACK = {
  CONFIRM: "c",
  CANCEL: "x",
  EDIT_ACCOUNT: "ea",
  EDIT_CATEGORY: "ec",
  ACCOUNT_PREFIX: "a:",
  CATEGORY_PREFIX: "k:",
  BACK: "b",
} as const;

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
    const last4 = a.last4s?.[0] ? ` *${a.last4s[0]}` : "";
    rows.push([
      {
        text: `${a.name}${last4} (${a.currency})`,
        callback_data: `${CALLBACK.ACCOUNT_PREFIX}${a.id}`,
      },
    ]);
  }
  rows.push([{ text: "⬅️ Volver", callback_data: CALLBACK.BACK }]);
  return { inline_keyboard: rows };
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
