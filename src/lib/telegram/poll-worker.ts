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

  let offset = await getOffset();
  let backoff = BACKOFF_MIN_MS;
  console.log(`[telegram] long-poll worker started (offset=${offset})`);

  while (!opts.signal?.aborted) {
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
      (opts.onError ?? ((e) => console.error("[telegram] poll error:", e)))(err);
      await delay(backoff, opts.signal);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  console.log("[telegram] long-poll worker stopped");
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
