// CLI para el consolidation flow del extracto Bancolombia (sub-issue #418).
//
// Invocación:
//   bun run statement:apply --file=<path> --user=<id> --account=<id> --cycle=YYYY-MM           # dry-run (default)
//   bun run statement:apply --file=<path> --user=<id> --account=<id> --cycle=YYYY-MM --commit  # writes
//   bun run statement:apply ... --json                                                          # machine-readable output
//
// Cuando `--commit` NO está presente (default), el script parsea el xlsx,
// corre el matcher contra el ledger y muestra un report tabular sin tocar DB.
// Con `--commit`, aplica los UPDATEs, INSERTea missing rows, y corre el job
// de intereses-causados. Idempotente via statement_imports.cycle unique
// partial index.

import { readFileSync } from "node:fs";

import {
  consolidateCycleFromStatement,
  hashStatementBuffer,
  type ConsolidationReport,
} from "../src/lib/ingestion/bancolombia-statement/consolidate";
import { parseBancolombiaStatement } from "../src/lib/ingestion/bancolombia-statement/xlsx";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "consolidate-statement" });

type Args = {
  file: string;
  user: number;
  account: number;
  cycle: string;
  commit: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv.slice(2)) {
    const kv = arg.match(/^--([a-z-]+)=(.+)$/i);
    if (kv) {
      out[kv[1]] = kv[2];
      continue;
    }
    const flag = arg.match(/^--([a-z-]+)$/i);
    if (flag) out[flag[1]] = true;
  }
  const file = typeof out.file === "string" ? out.file : "";
  const user = Number(out.user);
  const account = Number(out.account);
  const cycle = typeof out.cycle === "string" ? out.cycle : "";
  if (!file) throw new Error("--file=<path> is required");
  if (!Number.isInteger(user) || user <= 0) {
    throw new Error("--user=<id> is required and must be a positive integer");
  }
  if (!Number.isInteger(account) || account <= 0) {
    throw new Error("--account=<id> is required and must be a positive integer");
  }
  if (!/^\d{4}-\d{2}$/.test(cycle)) {
    throw new Error("--cycle=YYYY-MM is required");
  }
  return {
    file,
    user,
    account,
    cycle,
    commit: out.commit === true,
    json: out.json === true,
  };
}

function formatCents(strOrBig: string | bigint | null | undefined): string {
  if (strOrBig == null) return "—";
  const big = typeof strOrBig === "bigint" ? strOrBig : BigInt(strOrBig);
  const negative = big < BigInt(0);
  const abs = negative ? -big : big;
  const units = abs / BigInt(100);
  const fractional = (abs % BigInt(100)).toString().padStart(2, "0");
  const unitsStr = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${unitsStr},${fractional}`;
}

function rateLabel(x10k: number | null): string {
  if (x10k == null) return "—";
  const whole = Math.floor(x10k / 10_000);
  const frac = (x10k % 10_000).toString().padStart(4, "0");
  return `${whole},${frac} %`;
}

function renderReport(report: ConsolidationReport): string {
  const lines: string[] = [];
  const tag =
    report.status === "dry-run"
      ? "[DRY-RUN]"
      : report.status === "consolidated"
        ? "[COMMITTED]"
        : report.status === "already-consolidated"
          ? "[ALREADY-CONSOLIDATED]"
          : "[NO-OP]";
  lines.push(`${tag} user=${report.userId} account=${report.accountId} cycle=${report.cycle}`);
  lines.push("");
  lines.push("Match stats:");
  lines.push(`  matched              ${report.matchStats.matched}`);
  lines.push(`  will change (UPDATE) ${report.matchStats.matchedWillChange}`);
  lines.push(`  missing during-per   ${report.matchStats.insertedMissing}`);
  lines.push(`  missing before-per   ${report.matchStats.skippedMissingBefore} (skipped)`);
  lines.push(`  unmatched in ledger  ${report.matchStats.unmatchedInLedger}`);
  lines.push("");
  lines.push(`Intereses-causados: ${report.intereses.status}`);
  if (report.intereses.status === "inserted") {
    lines.push(`  synthetic tx id        ${report.intereses.txId}`);
    lines.push(`  total interest cents   ${formatCents(report.intereses.totalInterestCentsStr)}`);
    lines.push(`  purchases needing rate ${report.intereses.purchasesNeedingRate}`);
  } else if (report.intereses.status === "skipped") {
    lines.push(`  reason                 ${report.intereses.reason}`);
  } else {
    lines.push(`  reason                 ${report.intereses.reason}`);
  }

  if (report.matchedDiffs.length > 0) {
    lines.push("");
    lines.push("Matched rows with pending diffs:");
    lines.push("  TxId   Merchant                      Inst:before/after  Rate:before/after");
    for (const d of report.matchedDiffs) {
      if (!d.willChange) continue;
      lines.push(
        `  ${String(d.txId).padEnd(7)}${d.merchant.slice(0, 28).padEnd(30)} ${d.installmentsTotalBefore}→${d.installmentsTotalAfter}              ${rateLabel(d.rateEmX10kBefore)}→${rateLabel(d.rateEmX10kAfter)}`,
      );
    }
  }

  if (report.missingInLedger.length > 0) {
    lines.push("");
    lines.push("Missing in ledger (INSERT for during-period; skip for before-period):");
    for (const r of report.missingInLedger) {
      const marker = r.kind === "before-period" ? "[before, skip]" : "[insert]";
      lines.push(
        `  ${r.occurredAt.slice(0, 10)} auth=${r.authorizationNumber ?? "—"} ${formatCents(r.amountCentsStr).padStart(15)}  ${r.merchant}  ${marker}`,
      );
    }
  }

  if (report.unmatchedInLedgerIds.length > 0) {
    lines.push("");
    lines.push(
      `Unmatched ledger tx ids (present in DB, absent from statement — review): ${report.unmatchedInLedgerIds.join(", ")}`,
    );
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const buffer = readFileSync(args.file);
  const parsed = parseBancolombiaStatement(buffer);
  const fileHash = hashStatementBuffer(buffer);

  const report = await consolidateCycleFromStatement({
    userId: args.user,
    accountId: args.account,
    cycle: args.cycle,
    parsed,
    fileHash,
    dryRun: !args.commit,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }

  log.info(
    {
      userId: args.user,
      accountId: args.account,
      cycle: args.cycle,
      commit: args.commit,
      status: report.status,
      matched: report.matchStats.matched,
      willChange: report.matchStats.matchedWillChange,
      inserted: report.insertedTxIds.length,
      intereses: report.intereses.status,
      event: "consolidate_statement_run",
    },
    `consolidate-statement: status=${report.status}`,
  );
}

main()
  .then(async () => {
    await db.$client.end({ timeout: 1 }).catch(() => void 0);
  })
  .catch(async (err) => {
    log.error({ err, event: "consolidate_statement_failed" }, "consolidate-statement: run failed");
    await db.$client.end({ timeout: 1 }).catch(() => void 0);
    process.exit(1);
  });
