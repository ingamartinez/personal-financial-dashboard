import type { EditMessageOptions, SendMessageOptions, TelegramUpdate } from "@/lib/telegram/types";

const TELEGRAM_API = "https://api.telegram.org";

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description: string };

export type TelegramClient = {
  getUpdates: (opts: {
    offset?: number;
    timeout?: number;
    allowedUpdates?: string[];
  }) => Promise<TelegramUpdate[]>;
  sendMessage: (opts: SendMessageOptions) => Promise<{ message_id: number }>;
  editMessage: (opts: EditMessageOptions) => Promise<void>;
  answerCallbackQuery: (opts: { callback_query_id: string; text?: string }) => Promise<void>;
};

export function createTelegramClient(opts: {
  token: string;
  fetchImpl?: typeof fetch;
}): TelegramClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `${TELEGRAM_API}/bot${opts.token}`;

  async function call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await doFetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await res.json()) as TelegramResponse<T>;
    if (!payload.ok) {
      throw new Error(`Telegram API ${method} failed: ${payload.description}`);
    }
    return payload.result;
  }

  return {
    async getUpdates({ offset, timeout = 30, allowedUpdates }) {
      // Long-poll can take up to `timeout` seconds + network. Give it a bit
      // of headroom before AbortSignal fires and we need to retry.
      return call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout,
        allowed_updates: allowedUpdates ?? ["message", "callback_query"],
      });
    },
    async sendMessage(opts) {
      return call<{ message_id: number }>("sendMessage", opts);
    },
    async editMessage(opts) {
      await call<unknown>("editMessageText", opts);
    },
    async answerCallbackQuery(opts) {
      await call<unknown>("answerCallbackQuery", {
        callback_query_id: opts.callback_query_id,
        text: opts.text,
      });
    },
  };
}
