// CLI dry-run para el parser de extractos Bancolombia (sub-issue #417).
//
// Invocación:
//   bun run statement:parse --file=<path>           # tabla humana
//   bun run statement:parse --file=<path> --json    # ParsedStatement serializado
//
// No escribe a DB. Útil para smoke-testing manual del parser antes de
// conectarlo al matcher + consolidateCycle (sub-issue #415 B2).

import { readFileSync } from "node:fs";

import { parseBancolombiaStatement } from "../src/lib/ingestion/bancolombia-statement/xlsx";
import type {
  ParsedStatement,
  StatementRow,
} from "../src/lib/ingestion/bancolombia-statement/types";

function parseArgs(argv: string[]): { file: string; json: boolean } {
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
  if (!file) {
    throw new Error("--file=<path> is required");
  }
  return { file, json: out.json === true };
}

function formatCents(cents: bigint): string {
  const negative = cents < BigInt(0);
  const abs = negative ? -cents : cents;
  const units = abs / BigInt(100);
  const fractional = (abs % BigInt(100)).toString().padStart(2, "0");
  const unitsStr = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${unitsStr},${fractional}`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rateLabel(x10k: number | null): string {
  if (x10k == null) return "—";
  const whole = Math.floor(x10k / 10_000);
  const frac = (x10k % 10_000).toString().padStart(4, "0");
  return `${whole},${frac} %`;
}

function renderHuman(out: ParsedStatement): string {
  const lines: string[] = [];
  lines.push(`Account: ****${out.account.last4}  currency=${out.account.currency}`);
  lines.push(
    `Period: ${formatDate(out.period.startDate)} → ${formatDate(out.period.endDate)} (due ${formatDate(out.period.dueDate)})`,
  );
  lines.push("");
  lines.push("Summary:");
  lines.push(
    `  Saldo anterior       ${formatCents(out.summary.previousBalanceCents).padStart(18)}`,
  );
  lines.push(`  Compras del mes      ${formatCents(out.summary.purchasesCents).padStart(18)}`);
  lines.push(
    `  Intereses corrientes ${formatCents(out.summary.interestCorrientesCents).padStart(18)}`,
  );
  lines.push(`  Pagos / abonos       ${formatCents(out.summary.paymentsCents).padStart(18)}`);
  lines.push(`  Pago mínimo          ${formatCents(out.summary.minPaymentCents).padStart(18)}`);
  lines.push(`  Pago total           ${formatCents(out.summary.totalPaymentCents).padStart(18)}`);
  lines.push("");
  lines.push(
    `Rates EM: 1-mes=${rateLabel(out.currentRates.oneMonth)}  2-36m=${rateLabel(out.currentRates.months2to36)}  avances=${rateLabel(out.currentRates.advances)}`,
  );
  lines.push("");
  lines.push(
    `Rows: ${out.rows.length} total (${out.rows.filter((r) => r.kind === "during-period").length} durante, ${out.rows.filter((r) => r.kind === "before-period").length} antes)`,
  );
  lines.push("");
  lines.push("Date       Auth    Cuot     Rate EM  Amount            Merchant");
  for (const row of out.rows) {
    lines.push(formatRow(row));
  }
  return lines.join("\n");
}

function formatRow(row: StatementRow): string {
  const date = formatDate(row.occurredAt);
  const auth = (row.authorizationNumber ?? "—").padEnd(7);
  const cuotas = row.installments
    ? `${row.installments.paid}/${row.installments.total}`.padEnd(8)
    : "—".padEnd(8);
  const rate = rateLabel(row.rateEmX10k).padEnd(8);
  const amount = formatCents(row.amountCents).padStart(16);
  const marker = row.kind === "before-period" ? "[antes] " : "";
  return `${date} ${auth} ${cuotas} ${rate} ${amount}  ${marker}${row.merchant}`;
}

// JSON.stringify chokes on bigint. Normalize to strings.
function toSerializable(out: ParsedStatement): unknown {
  return {
    ...out,
    period: {
      startDate: out.period.startDate.toISOString(),
      endDate: out.period.endDate.toISOString(),
      dueDate: out.period.dueDate.toISOString(),
    },
    summary: Object.fromEntries(Object.entries(out.summary).map(([k, v]) => [k, v.toString()])),
    rows: out.rows.map((r) => ({
      ...r,
      occurredAt: r.occurredAt.toISOString(),
      amountCents: r.amountCents.toString(),
      installmentValueCents: r.installmentValueCents?.toString() ?? null,
      saldoPendingCents: r.saldoPendingCents.toString(),
    })),
  };
}

function main(): void {
  const { file, json } = parseArgs(process.argv);
  const buffer = readFileSync(file);
  const parsed = parseBancolombiaStatement(buffer);
  if (json) {
    process.stdout.write(`${JSON.stringify(toSerializable(parsed), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(parsed)}\n`);
  }
}

main();
