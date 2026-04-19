import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { parseSmsBancolombia, type ParseResult } from "../src/lib/ingestion/sms-bancolombia";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "analyze-sms-dump" });

type Source =
  | { kind: "db" }
  | { kind: "csv"; path: string }
  | { kind: "imessage-dir"; path: string };

function parseArgs(): Source {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "db") return { kind: "db" };
  if (args[0] === "csv") {
    const path = args[1];
    if (!path || !existsSync(path)) {
      throw new Error(`csv path not found: ${path}`);
    }
    return { kind: "csv", path };
  }
  if (args[0] === "imessage-dir") {
    const path = args[1];
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`imessage-dir path not found or not a directory: ${path}`);
    }
    return { kind: "imessage-dir", path };
  }
  throw new Error(
    `usage: bun run scripts/analyze-sms-dump.ts [db | csv <path> | imessage-dir <path>]`,
  );
}

async function loadFromDb(): Promise<string[]> {
  const rows = await db.execute<{ body: string }>(sql`
    SELECT payload->>'body' AS body
    FROM ingestion_logs
    WHERE source = 'sms'
      AND payload->>'body' IS NOT NULL
  `);
  return rows.map((r) => r.body);
}

// RFC-4180-ish CSV parser, respects quoted fields with "" escape and embedded newlines.
function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuote = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (cur.length > 0 || row.length > 0) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      }
      if (ch === "\r" && raw[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function loadFromCsv(path: string): string[] {
  const raw = readFileSync(path, "utf-8");
  const rows = parseCsv(raw);
  const bodies: string[] = [];
  for (const row of rows) {
    const body = row[2] ?? row[row.length - 1];
    if (body && body.trim().length > 0) bodies.push(body);
  }
  return bodies;
}

// imessage-exporter txt layout per block, blank-line separated:
//   line 1:  timestamp header (e.g. "Dec 09, 2025  4:32:26 PM (Read by you ...)")
//   line 2:  sender handle (e.g. "85540")
//   line 3+: message body (one or more lines)
const HEADER_RE = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/;

function loadFromImessageDir(dir: string): string[] {
  const bodies: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".txt")) continue;
    if (entry === "orphaned.txt") continue;
    const raw = readFileSync(join(dir, entry), "utf-8");
    const blocks = raw.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split("\n").map((l) => l.trimEnd());
      if (lines.length < 3) continue;
      if (!HEADER_RE.test(lines[0])) continue;
      const body = lines.slice(2).join(" ").trim();
      if (body.length > 0) bodies.push(body);
    }
  }
  return bodies;
}

// Collapse variable tokens so similar SMS templates cluster together.
// Order matters: dates/times before bare-number rule, amounts before *NNNN.
function normalize(body: string): string {
  return body
    .replace(/\d{1,4}\/\d{1,2}\/\d{1,4}/g, "DATE")
    .replace(/\d{1,2}:\d{2}/g, "TIME")
    .replace(/COP[\d.,]+|USD[\d.,]+|\$\s?[\d.,]+/g, "AMT")
    .replace(/\*+\d{4,}/g, "*NNNN")
    .replace(/\b\d{4,}\b/g, "NNNN")
    .replace(/\s+/g, " ")
    .trim();
}

type Bucket = { count: number; samples: string[] };

type QrStat = {
  count: number;
  totalCents: bigint;
  dates: Set<string>;
  fromLast4s: Set<string>;
};

function fmtCop(cents: bigint): string {
  const whole = Number(cents) / 100;
  return whole.toLocaleString("es-CO", { maximumFractionDigits: 0 });
}

async function main() {
  const src = parseArgs();
  const bodies =
    src.kind === "db"
      ? await loadFromDb()
      : src.kind === "csv"
        ? loadFromCsv(src.path)
        : loadFromImessageDir(src.path);

  const byKind = new Map<string, number>();
  const unknownPatterns = new Map<string, Bucket>();
  const qrKeys = new Map<string, QrStat>();
  const parsedResults: { body: string; result: ParseResult }[] = [];

  for (const body of bodies) {
    const result = parseSmsBancolombia(body);
    parsedResults.push({ body, result });

    if (result.kind === "skip") {
      const k = `skip:${result.reason}`;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
      if (result.reason === "unknown") {
        const n = normalize(body);
        const b = unknownPatterns.get(n) ?? { count: 0, samples: [] };
        b.count++;
        if (b.samples.length < 2) b.samples.push(body);
        unknownPatterns.set(n, b);
      }
      continue;
    }

    byKind.set(result.kind, (byKind.get(result.kind) ?? 0) + 1);
    if (result.kind === "qr_payment") {
      const s = qrKeys.get(result.toKey) ?? {
        count: 0,
        totalCents: BigInt(0),
        dates: new Set<string>(),
        fromLast4s: new Set<string>(),
      };
      s.count++;
      s.totalCents += result.amountCents;
      s.dates.add(result.occurredOn);
      s.fromLast4s.add(result.fromLast4);
      qrKeys.set(result.toKey, s);
    }
  }

  const out: string[] = [];
  out.push(`# SMS Bancolombia — Analysis Report`);
  out.push(``);
  const sourceLabel = src.kind === "db" ? "db" : `${src.kind} (${src.path})`;
  out.push(`Source: \`${sourceLabel}\`  `);
  out.push(`Total bodies: **${bodies.length}**`);
  out.push(``);

  out.push(`## Breakdown by kind`);
  out.push(``);
  out.push(`| Kind | Count | % |`);
  out.push(`|---|---:|---:|`);
  const sortedKinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of sortedKinds) {
    const pct = ((count / bodies.length) * 100).toFixed(1);
    out.push(`| \`${kind}\` | ${count} | ${pct}% |`);
  }
  out.push(``);

  out.push(`## QR payments`);
  out.push(``);
  const sortedKeys = [...qrKeys.entries()].sort((a, b) => b[1].count - a[1].count);
  out.push(`Unique keys: **${sortedKeys.length}**`);
  out.push(``);
  if (sortedKeys.length > 0) {
    out.push(`| Key | Count | Total (COP) | From last4 | First | Last |`);
    out.push(`|---|---:|---:|---|---|---|`);
    for (const [key, s] of sortedKeys.slice(0, 20)) {
      const dates = [...s.dates].sort();
      out.push(
        `| \`${key}\` | ${s.count} | $${fmtCop(s.totalCents)} | ${[...s.fromLast4s].join(",")} | ${dates[0]} | ${dates[dates.length - 1]} |`,
      );
    }
  }
  out.push(``);

  out.push(`## Unknown patterns (need new regex or skip rule)`);
  out.push(``);
  const sortedUnknown = [...unknownPatterns.entries()].sort((a, b) => b[1].count - a[1].count);
  if (sortedUnknown.length === 0) {
    out.push(`_No unknown bodies — everything parsed or was skipped by rule._`);
  } else {
    for (const [pattern, b] of sortedUnknown) {
      out.push(`### ${b.count}× — template`);
      out.push("");
      out.push("```");
      out.push(pattern);
      out.push("```");
      out.push(`Sample:`);
      out.push(`> ${b.samples[0]}`);
      out.push(``);
    }
  }

  log.info({ event: "analyze_sms_report" }, out.join("\n"));

  if (src.kind === "db") {
    await db.$client.end();
  }
  process.exit(0);
}

main().catch((err) => {
  log.error({ err, event: "analyze_sms_failed" }, "analyze-sms-dump failed");
  process.exit(1);
});
