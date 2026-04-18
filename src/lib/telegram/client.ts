import { request, type RequestOptions } from "node:https";
import type {
  EditMessageOptions,
  SendMessageOptions,
  TelegramFile,
  TelegramUpdate,
} from "@/lib/telegram/types";

const TELEGRAM_HOST = "api.telegram.org";

type TelegramResponse<T> = { ok: true; result: T } | { ok: false; description: string };

export type TelegramBotProfile = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
};

export type TelegramClient = {
  getUpdates: (opts: {
    offset?: number;
    timeout?: number;
    allowedUpdates?: string[];
  }) => Promise<TelegramUpdate[]>;
  sendMessage: (opts: SendMessageOptions) => Promise<{ message_id: number }>;
  editMessage: (opts: EditMessageOptions) => Promise<void>;
  answerCallbackQuery: (opts: { callback_query_id: string; text?: string }) => Promise<void>;
  getFile: (fileId: string) => Promise<TelegramFile>;
  downloadFile: (filePath: string) => Promise<Buffer>;
  getMe: () => Promise<TelegramBotProfile>;
  setWebhook: (opts: { url: string; secretToken: string }) => Promise<void>;
  deleteWebhook: (opts?: { dropPendingUpdates?: boolean }) => Promise<void>;
};

// Built on node:https (not fetch) because undici's default fetch in Node 20+
// enables Happy Eyeballs at the socket level (autoSelectFamily: true). On
// networks where IPv6 egress is broken (ia-server's ISP), the IPv6 connection
// attempt dominates the 30s long-poll window and the fetch times out before
// falling back to IPv4. node:https.request respects `dns.setDefaultResultOrder`
// and lets us pin `family: 4`, which bypasses the issue entirely.
type RawResponse = { status: number; body: string };

function httpsBinary(opts: { path: string; timeoutMs: number }): Promise<Buffer> {
  const reqOpts: RequestOptions = {
    host: TELEGRAM_HOST,
    port: 443,
    path: opts.path,
    method: "GET",
    family: 4,
  };
  return new Promise((resolve, reject) => {
    const req = request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Telegram file download failed: status ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Telegram download timed out after ${opts.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

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
    async getFile(fileId) {
      return call<TelegramFile>("getFile", { file_id: fileId }, 10_000);
    },
    async downloadFile(filePath) {
      return httpsBinary({
        path: `/file/bot${opts.token}/${filePath}`,
        timeoutMs: 30_000,
      });
    },
    async getMe() {
      return call<TelegramBotProfile>("getMe", {}, 10_000);
    },
    async setWebhook({ url, secretToken }) {
      await call<true>(
        "setWebhook",
        {
          url,
          secret_token: secretToken,
          allowed_updates: ["message", "callback_query"],
        },
        15_000,
      );
    },
    async deleteWebhook(deleteOpts) {
      await call<true>(
        "deleteWebhook",
        {
          drop_pending_updates: deleteOpts?.dropPendingUpdates ?? false,
        },
        10_000,
      );
    },
  };
}
