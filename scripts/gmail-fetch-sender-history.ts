/**
 * Historical Gmail fetch for a registered sender over an explicit window.
 *
 * The incremental cron advances a per-connection cursor (`last_pull_at`).
 * Registering a new sender therefore sees future mail only — never the
 * itinerary / purchase confirmation that already landed. This script pulls
 * that window through the same persist + parse + correlate path as the cron
 * (`pullForUser`), including evidence-mode gateways, and does NOT write the
 * cursor.
 *
 * Idempotent: duplicate `gmail_msg_id`s are skipped (A+ unique on
 * `(user_id, gmail_msg_id)`). Overlapping reruns are safe.
 *
 * Reachable on prod after #850 (whole-tree `scripts/` + `src/` overlay).
 * Do not run against prod from a worktree — that is an ops step after merge.
 *
 * CLI:
 *   --user-id=N          Required.
 *   --sender=<domain>    Repeatable. Must match a registered senderQuery
 *                        (`jetsmart.com`, `mercadolibre.com`, …).
 *   --from=YYYY-MM-DD    Window start, inclusive, UTC.
 *   --to=YYYY-MM-DD      Window end, inclusive, UTC.
 *   --dry-run            Resolve senders and print the plan; no Gmail calls.
 *
 * Ops (user 1, the three senders added since Phase 1 — parent runs this):
 *   bun scripts/gmail-fetch-sender-history.ts --user-id=1 \
 *     --sender=mercadolibre.com --sender=mercadolibre.com.co \
 *     --sender=jetsmart.com --from=2026-01-01 --to=2026-09-09
 */

import { createLogger } from "../src/lib/logger";
import { pullForUser } from "../src/lib/gmail/pull";
import { resolveRegisteredSenders } from "../src/lib/gmail/registry";

const log = createLogger({ module: "gmail-fetch-sender-history" });

export type FetchSenderHistoryArgs = {
  userId: number;
  senders: string[];
  from: Date;
  until: Date;
  dryRun: boolean;
};

export function parseUtcDay(raw: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`invalid date ${raw}`);
  }
  return d;
}

export function parseFetchSenderHistoryArgs(argv: string[]): FetchSenderHistoryArgs {
  let userId: number | null = null;
  const senders: string[] = [];
  let from: Date | null = null;
  let toInclusive: Date | null = null;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      const n = Number(arg.slice("--user-id=".length));
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--user-id must be a positive integer");
      }
      userId = n;
      continue;
    }
    if (arg.startsWith("--sender=")) {
      const s = arg.slice("--sender=".length).trim();
      if (s.length === 0) throw new Error("--sender must be a non-empty domain");
      senders.push(s);
      continue;
    }
    if (arg.startsWith("--from=")) {
      from = parseUtcDay(arg.slice("--from=".length));
      continue;
    }
    if (arg.startsWith("--to=")) {
      toInclusive = parseUtcDay(arg.slice("--to=".length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (userId === null) throw new Error("--user-id is required");
  if (senders.length === 0) throw new Error("at least one --sender is required");
  if (from === null) throw new Error("--from=YYYY-MM-DD is required");
  if (toInclusive === null) throw new Error("--to=YYYY-MM-DD is required");
  if (toInclusive.getTime() < from.getTime()) {
    throw new Error("--to must be on or after --from");
  }

  return {
    userId,
    senders,
    from,
    until: new Date(toInclusive.getTime() + 86_400_000),
    dryRun,
  };
}

export async function runFetchSenderHistory(
  args: FetchSenderHistoryArgs,
  deps: { pull?: typeof pullForUser } = {},
): Promise<void> {
  const plans = resolveRegisteredSenders(args.senders);
  log.info(
    {
      userId: args.userId,
      senders: args.senders,
      from: args.from.toISOString(),
      until: args.until.toISOString(),
      dryRun: args.dryRun,
      gateways: plans.map((p) => ({
        id: p.gateway.id,
        mode: p.gateway.mode,
        senderQueries: p.senderQueries,
      })),
      event: "gmail_sender_history_plan",
    },
    "historical sender fetch plan",
  );

  if (args.dryRun) return;

  const pull = deps.pull ?? pullForUser;
  const result = await pull(args.userId, {
    senders: args.senders,
    overrideSince: args.from,
    until: args.until,
    preserveCursor: true,
  });

  log.info(
    {
      userId: args.userId,
      pulled: result.pulled,
      skipped: result.skipped,
      byGateway: result.byGateway,
      errors: result.errors,
      connectionId: result.connectionId,
      event: "gmail_sender_history_done",
    },
    "historical sender fetch complete",
  );

  if (result.errors.length > 0) {
    throw new Error(`historical fetch completed with ${result.errors.length} error(s)`);
  }
}

async function main(): Promise<void> {
  const args = parseFetchSenderHistoryArgs(process.argv.slice(2));
  await runFetchSenderHistory(args);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err, event: "gmail_sender_history_failed" }, "historical sender fetch failed");
      process.exit(1);
    });
}
