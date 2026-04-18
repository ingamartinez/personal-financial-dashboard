import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramPollState } from "@/lib/db/schema";
import { createTelegramClient, type TelegramClient } from "@/lib/telegram/client";
import { handleUpdate, type RouterDeps } from "@/lib/telegram/router";
import { parseAllowlist } from "@/lib/telegram/allowlist";
import { parseTransactionMessage } from "@/lib/ai/transaction-nlu";
import { listAccountsDetailed } from "@/lib/accounts/queries";
import { listCategories } from "@/lib/transactions/queries";

const POLL_STATE_ROW_ID = 1;
const LONG_POLL_TIMEOUT_SECONDS = 30;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

async function getOffset(): Promise<number> {
  const rows = await db
    .select({ lastUpdateId: telegramPollState.lastUpdateId })
    .from(telegramPollState)
    .where(eq(telegramPollState.id, POLL_STATE_ROW_ID))
    .limit(1);
  if (rows.length === 0) {
    await db.insert(telegramPollState).values({
      id: POLL_STATE_ROW_ID,
      lastUpdateId: BigInt(0),
      updatedAt: new Date(),
    });
    return 0;
  }
  return Number(rows[0].lastUpdateId);
}

async function setOffset(updateId: number): Promise<void> {
  await db
    .update(telegramPollState)
    .set({ lastUpdateId: BigInt(updateId), updatedAt: new Date() })
    .where(eq(telegramPollState.id, POLL_STATE_ROW_ID));
}

export type PollWorkerOptions = {
  token: string;
  allowedUserIds: string | undefined;
  client?: TelegramClient;
  deps?: Partial<RouterDeps>;
  signal?: AbortSignal;
  onError?: (err: unknown) => void;
};

export async function runPollWorker(opts: PollWorkerOptions): Promise<void> {
  const client = opts.client ?? createTelegramClient({ token: opts.token });
  const allowlist = parseAllowlist(opts.allowedUserIds);
  if (allowlist.size === 0) {
    console.warn("[telegram] allowlist is empty — bot will reject everyone");
  }

  const routerDeps: RouterDeps = {
    allowlist,
    listAccounts: opts.deps?.listAccounts ?? listAccountsDetailed,
    listCategories: opts.deps?.listCategories ?? listCategories,
    parseNlu:
      opts.deps?.parseNlu ?? ((p) => parseTransactionMessage({ text: p.text, context: p.context })),
    now: opts.deps?.now,
  };

  // If no external signal is provided, own the shutdown lifecycle. This keeps
  // `process.once` out of `instrumentation.ts` (which Next.js analyzes for
  // Edge runtime compatibility) and limits it to this Node-only module.
  const ownedAbort = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? ownedAbort!.signal;
  const shutdown = () => ownedAbort?.abort();
  if (ownedAbort) {
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }

  let offset = await getOffset();
  let backoff = BACKOFF_MIN_MS;
  console.log(`[telegram] long-poll worker started (offset=${offset})`);

  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates({
        offset: offset + 1,
        timeout: LONG_POLL_TIMEOUT_SECONDS,
      });
      backoff = BACKOFF_MIN_MS;

      for (const update of updates) {
        try {
          await handleUpdate(update, client, routerDeps);
        } catch (err) {
          (opts.onError ?? ((e) => console.error("[telegram] handler error:", e)))(err);
        }
        if (update.update_id > offset) {
          offset = update.update_id;
          await setOffset(offset);
        }
      }
    } catch (err) {
      const reason = describePollError(err);
      (opts.onError ?? ((e) => console.error(`[telegram] poll error (${reason}):`, e)))(err);
      await delay(backoff, signal);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  console.log("[telegram] long-poll worker stopped");
}

function describePollError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    if (cause?.code === "ETIMEDOUT")
      return "network timeout reaching api.telegram.org — check connectivity";
    if (cause?.code === "ENOTFOUND") return "DNS lookup failed for api.telegram.org";
    if (cause?.code === "ECONNREFUSED") return "connection refused by api.telegram.org";
    if (err.message.includes("401")) return "invalid TELEGRAM_BOT_TOKEN";
    return err.message;
  }
  return String(err);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
