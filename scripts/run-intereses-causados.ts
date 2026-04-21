// #407: CLI wrapper around `applyInteresesCausadosForCycle`. For now we
// invoke this manually (user runs `bun run intereses:run ...` at each cycle
// cutoff); a cron trigger can be wired later once the job is battle-tested.
//
// Invocation:
//   bun run intereses:run --user=<id> --account=<id> --cycle=YYYY-MM
//
// Required flags:
//   --user     findash user id (int)
//   --account  TC account id to run for (int)
//   --cycle    YYYY-MM of the cycle being closed (e.g. 2026-04)
//
// Idempotent: re-running the same (user, account, cycle) triple skips with
// reason "already-run". Logs the outcome as a structured line — no exit
// code distinction between inserted / skipped (both are successful paths).

import { applyInteresesCausadosForCycle } from "../src/lib/finance/intereses-causados-job";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "run-intereses-causados" });

function parseArgs(argv: string[]): { user: number; account: number; cycle: string } {
  const out: Record<string, string> = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z]+)=(.+)$/i);
    if (m) out[m[1]] = m[2];
  }
  const user = Number(out.user);
  const account = Number(out.account);
  const cycle = out.cycle;
  if (!Number.isInteger(user) || user <= 0) {
    throw new Error("--user=<id> is required and must be a positive integer");
  }
  if (!Number.isInteger(account) || account <= 0) {
    throw new Error("--account=<id> is required and must be a positive integer");
  }
  if (!cycle || !/^\d{4}-\d{2}$/.test(cycle)) {
    throw new Error("--cycle=YYYY-MM is required");
  }
  return { user, account, cycle };
}

async function main() {
  const { user, account, cycle } = parseArgs(process.argv);
  const result = await applyInteresesCausadosForCycle({
    userId: user,
    accountId: account,
    cycle,
  });
  log.info(
    {
      userId: user,
      accountId: account,
      cycle,
      result,
      event: "intereses_causados_run",
    },
    `intereses-causados: status=${result.status}`,
  );
  await db.$client.end({ timeout: 1 });
  if (result.status === "error") process.exit(1);
}

main().catch(async (err) => {
  log.error({ err, event: "intereses_causados_failed" }, "intereses-causados CLI failed");
  await db.$client.end({ timeout: 1 }).catch(() => void 0);
  process.exit(1);
});
