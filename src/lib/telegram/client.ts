import { request, type RequestOptions } from "node:https";
import type { EditMessageOptions, SendMessageOptions, TelegramUpdate } from "@/lib/telegram/types";

const TELEGRAM_HOST = "api.telegram.org";

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

// Built on node:https (not fetch) because undici's default fetch in Node 20+
// enables Happy Eyeballs at the socket level (autoSelectFamily: true). On
// networks where IPv6 egress is broken (ia-server's ISP), the IPv6 connection
// attempt dominates the 30s long-poll window and the fetch times out before
// falling back to IPv4. node:https.request respects `dns.setDefaultResultOrder`
// and lets us pin `family: 4`, which bypasses the issue entirely.
type RawResponse = { status: number; body: string };

function httpsJson(opts: {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
}): Promise<RawResponse> {
  const payload = opts.body == null ? "" : JSON.stringify(opts.body);
  const reqOpts: RequestOptions = {
    host: TELEGRAM_HOST,
    port: 443,
    path: opts.path,
    method: opts.method,
    family: 4,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload).toString(),
    },
  };

  return new Promise((resolve, reject) => {
    const req = request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Telegram request timed out after ${opts.timeoutMs}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createTelegramClient(opts: { token: string }): TelegramClient {
  const basePath = `/bot${opts.token}`;

  async function call<T>(method: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await httpsJson({
      method: "POST",
      path: `${basePath}/${method}`,
      body,
      timeoutMs,
    });
    let payload: TelegramResponse<T>;
    try {
      payload = JSON.parse(res.body) as TelegramResponse<T>;
    } catch {
      throw new Error(`Telegram API ${method} returned non-JSON (status ${res.status})`);
    }
    if (!payload.ok) {
      throw new Error(`Telegram API ${method} failed (${res.status}): ${payload.description}`);
    }
    return payload.result;
  }

  return {
    async getUpdates({ offset, timeout = 30, allowedUpdates }) {
      // Telegram holds the connection open for up to `timeout` seconds waiting
      // for new updates. Add ~15s of network headroom on top before we give up.
      return call<TelegramUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout,
          allowed_updates: allowedUpdates ?? ["message", "callback_query"],
        },
        (timeout + 15) * 1000,
      );
    },
    async sendMessage(opts) {
      return call<{ message_id: number }>("sendMessage", opts, 15_000);
    },
    async editMessage(opts) {
      await call<unknown>("editMessageText", opts, 15_000);
    },
    async answerCallbackQuery(opts) {
      await call<unknown>(
        "answerCallbackQuery",
        { callback_query_id: opts.callback_query_id, text: opts.text },
        10_000,
      );
    },
  };
}
