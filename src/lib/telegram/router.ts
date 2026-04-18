import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery } from "@/lib/telegram/types";
import type { AccountDetail } from "@/lib/accounts/queries";
import type { NluAccountOption, NluCategoryOption, NluResult } from "@/lib/ai/transaction-nlu";
import type { TelegramDraft, TelegramSessionState } from "@/lib/db/schema";
import { isAllowed } from "@/lib/telegram/allowlist";
import { handleCommand, parseCommand } from "@/lib/telegram/commands";
import { clearSession, getSession, mergeDraft, upsertSession } from "@/lib/telegram/session";
import {
  accountsKeyboard,
  categoriesKeyboard,
  CALLBACK,
  confirmKeyboard,
} from "@/lib/telegram/keyboard";
import {
  renderAskAccount,
  renderAskAmount,
  renderAskCategory,
  renderCanceled,
  renderConfirmCard,
  renderError,
  renderInserted,
  renderUnauthorized,
} from "@/lib/telegram/formatter";
import { insertFromDraft, isDraftComplete } from "@/lib/telegram/confirm";

export type RouterDeps = {
  allowlist: Set<number>;
  listAccounts: () => Promise<AccountDetail[]>;
  listCategories: () => Promise<NluCategoryOption[]>;
  parseNlu: (opts: {
    text: string;
    context: { now: Date; accounts: NluAccountOption[]; categories: NluCategoryOption[] };
  }) => Promise<NluResult>;
  now?: () => Date;
};

function accountsToNluOptions(accounts: AccountDetail[]): NluAccountOption[] {
  return accounts
    .filter((a) => a.active)
    .map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      currency: a.currency,
      last4s: a.metadata?.last4s,
    }));
}

export function parseAmountFromText(text: string): string | null {
  const trimmed = text.trim().replace(/\$/g, "").replace(/\s+/g, " ");

  const kMatch = trimmed.match(/^(\d+(?:[,.]\d+)?)\s*[kK]$/);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(",", "."));
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 1000 * 100)));
  }

  const milMatch = trimmed.match(/^(\d+(?:[,.]\d+)?)\s*mil$/i);
  if (milMatch) {
    const val = parseFloat(milMatch[1].replace(",", "."));
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 1000 * 100)));
  }

  const mMatch = trimmed.match(/^(\d+(?:[,.]\d+)?)\s*(?:millones?|m|M)$/);
  if (mMatch) {
    const val = parseFloat(mMatch[1].replace(",", "."));
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 1_000_000 * 100)));
  }

  // Plain number (es-CO): dots are thousand separators, comma is decimal.
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(trimmed)) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".");
    const val = parseFloat(normalized);
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 100)));
  }
  if (/^\d+(,\d+)?$/.test(trimmed)) {
    const normalized = trimmed.replace(",", ".");
    const val = parseFloat(normalized);
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 100)));
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const val = parseFloat(trimmed);
    if (Number.isFinite(val)) return String(BigInt(Math.round(val * 100)));
  }

  return null;
}

function pickDefaultCurrency(accounts: NluAccountOption[], accountId?: number): "COP" | "USD" {
  if (typeof accountId === "number") {
    const acc = accounts.find((a) => a.id === accountId);
    if (acc) return acc.currency;
  }
  return "COP";
}

async function advanceFlow(opts: {
  chatId: number;
  userId: number;
  state: TelegramSessionState;
  accounts: NluAccountOption[];
  categories: NluCategoryOption[];
  client: TelegramClient;
}): Promise<void> {
  const { chatId, userId, state, accounts, categories, client } = opts;
  const draft = state.draft;

  if (!draft.amountCents) {
    const next: TelegramSessionState = { ...state, step: "awaiting_amount" };
    await upsertSession({ chatId, userId, state: next });
    await client.sendMessage({ chat_id: chatId, text: renderAskAmount() });
    return;
  }

  if (typeof draft.accountId !== "number") {
    const next: TelegramSessionState = { ...state, step: "awaiting_account" };
    await upsertSession({ chatId, userId, state: next });
    await client.sendMessage({
      chat_id: chatId,
      text: renderAskAccount(),
      reply_markup: accountsKeyboard(accounts),
    });
    return;
  }

  const next: TelegramSessionState = { ...state, step: "awaiting_confirm" };
  const sent = await client.sendMessage({
    chat_id: chatId,
    text: renderConfirmCard({ draft, accounts, categories }),
    reply_markup: confirmKeyboard(),
  });
  next.promptMessageId = sent.message_id;
  await upsertSession({ chatId, userId, state: next });
}

async function handleText(
  message: TelegramMessage,
  client: TelegramClient,
  deps: RouterDeps,
): Promise<void> {
  const text = message.text ?? "";
  const chatId = message.chat.id;
  const userId = message.from?.id ?? 0;

  const command = parseCommand(text);
  if (command) {
    await handleCommand({ command, chatId, client });
    return;
  }

  const existing = await getSession(chatId);

  // awaiting_amount: treat text as amount first, fall back to full re-parse.
  if (existing?.step === "awaiting_amount") {
    const amountCents = parseAmountFromText(text);
    if (amountCents) {
      const patched = mergeDraft(existing, { amountCents });
      const accounts = accountsToNluOptions(await deps.listAccounts());
      const categories = await deps.listCategories();
      await advanceFlow({ chatId, userId, state: patched, accounts, categories, client });
      return;
    }
  }

  // Otherwise: re-parse the whole message with NLU (starts a fresh draft).
  const accountsFull = await deps.listAccounts();
  const accounts = accountsToNluOptions(accountsFull);
  const categories = await deps.listCategories();
  const now = (deps.now ?? (() => new Date()))();

  let nlu: NluResult;
  try {
    nlu = await deps.parseNlu({ text, context: { now, accounts, categories } });
  } catch (err) {
    console.error("[telegram] NLU parse failed:", err);
    await client.sendMessage({
      chat_id: chatId,
      text: renderError(
        "No pude entender el mensaje. Probá reformularlo con monto y descripción más claras (ej: 'pagué 45k en el restaurante').",
      ),
    });
    return;
  }

  const draft: TelegramDraft = {
    amountCents: nlu.draft.amountCents ?? undefined,
    currency: nlu.draft.currency ?? pickDefaultCurrency(accounts, nlu.draft.accountId ?? undefined),
    direction: nlu.draft.direction ?? "expense",
    merchant: nlu.draft.merchant ?? undefined,
    description: nlu.draft.description ?? undefined,
    occurredOn: nlu.draft.occurredOn ?? undefined,
    accountId: nlu.draft.accountId ?? undefined,
    categorySlug: nlu.draft.categorySlug ?? undefined,
    notes: nlu.draft.notes,
  };

  // Auto-pick the account when there's exactly one active account in that currency.
  if (typeof draft.accountId !== "number") {
    const matches = accounts.filter((a) => a.currency === draft.currency);
    if (matches.length === 1) draft.accountId = matches[0].id;
  }

  const state: TelegramSessionState = {
    step: "idle",
    draft,
    sourceChatId: chatId,
    sourceMessageId: message.message_id,
  };

  await advanceFlow({ chatId, userId, state, accounts, categories, client });
}

async function handleCallback(
  cb: TelegramCallbackQuery,
  client: TelegramClient,
  deps: RouterDeps,
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const userId = cb.from.id;
  if (typeof chatId !== "number") {
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    return;
  }

  const session = await getSession(chatId);
  if (!session) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Sesión expirada" });
    await client.sendMessage({
      chat_id: chatId,
      text: "La sesión expiró. Mandame el mensaje de nuevo.",
    });
    return;
  }

  const accountsFull = await deps.listAccounts();
  const accounts = accountsToNluOptions(accountsFull);
  const categories = await deps.listCategories();

  if (data === CALLBACK.CONFIRM) {
    if (!isDraftComplete(session.draft)) {
      await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Faltan datos" });
      await advanceFlow({ chatId, userId, state: session, accounts, categories, client });
      return;
    }
    const result = await insertFromDraft({
      draft: session.draft,
      chatId,
      sourceMessageId: session.sourceMessageId,
    });
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    if (result.status === "inserted") {
      await client.sendMessage({ chat_id: chatId, text: renderInserted(result.txId) });
      await clearSession(chatId);
    } else if (result.status === "duplicated") {
      await client.sendMessage({
        chat_id: chatId,
        text: renderError("Ya había una transacción con el mismo origen."),
      });
      await clearSession(chatId);
    } else {
      await client.sendMessage({ chat_id: chatId, text: renderError(`Error: ${result.reason}`) });
    }
    return;
  }

  if (data === CALLBACK.CANCEL) {
    await clearSession(chatId);
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await client.sendMessage({ chat_id: chatId, text: renderCanceled() });
    return;
  }

  if (data === CALLBACK.EDIT_ACCOUNT) {
    const next: TelegramSessionState = { ...session, step: "awaiting_account" };
    await upsertSession({ chatId, userId, state: next });
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await client.sendMessage({
      chat_id: chatId,
      text: renderAskAccount(),
      reply_markup: accountsKeyboard(accounts),
    });
    return;
  }

  if (data === CALLBACK.EDIT_CATEGORY) {
    const next: TelegramSessionState = { ...session, step: "awaiting_category" };
    await upsertSession({ chatId, userId, state: next });
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await client.sendMessage({
      chat_id: chatId,
      text: renderAskCategory(),
      reply_markup: categoriesKeyboard(categories),
    });
    return;
  }

  if (data === CALLBACK.BACK) {
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await advanceFlow({ chatId, userId, state: session, accounts, categories, client });
    return;
  }

  if (data.startsWith(CALLBACK.ACCOUNT_PREFIX)) {
    const id = Number(data.slice(CALLBACK.ACCOUNT_PREFIX.length));
    if (!Number.isInteger(id) || !accounts.some((a) => a.id === id)) {
      await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Cuenta inválida" });
      return;
    }
    const picked = accounts.find((a) => a.id === id)!;
    const patched = mergeDraft(session, {
      accountId: id,
      currency: picked.currency,
    });
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await advanceFlow({ chatId, userId, state: patched, accounts, categories, client });
    return;
  }

  if (data.startsWith(CALLBACK.CATEGORY_PREFIX)) {
    const slug = data.slice(CALLBACK.CATEGORY_PREFIX.length);
    if (!categories.some((c) => c.slug === slug)) {
      await client.answerCallbackQuery({ callback_query_id: cb.id, text: "Categoría inválida" });
      return;
    }
    const patched = mergeDraft(session, { categorySlug: slug });
    await client.answerCallbackQuery({ callback_query_id: cb.id });
    await advanceFlow({ chatId, userId, state: patched, accounts, categories, client });
    return;
  }

  await client.answerCallbackQuery({ callback_query_id: cb.id });
}

export async function handleUpdate(
  update: TelegramUpdate,
  client: TelegramClient,
  deps: RouterDeps,
): Promise<void> {
  if (update.message) {
    const msg = update.message;
    if (!isAllowed(msg.from?.id, deps.allowlist)) {
      if (msg.from?.id) {
        await client.sendMessage({ chat_id: msg.chat.id, text: renderUnauthorized() });
      }
      return;
    }
    if (typeof msg.text === "string") {
      await handleText(msg, client, deps);
    }
    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    if (!isAllowed(cb.from.id, deps.allowlist)) {
      await client.answerCallbackQuery({ callback_query_id: cb.id, text: "No autorizado" });
      return;
    }
    await handleCallback(cb, client, deps);
  }
}
