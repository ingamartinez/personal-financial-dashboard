import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { ingestParsed } from "../src/lib/ingestion/sms-pipeline";
import { parseSmsBancolombia } from "../src/lib/ingestion/sms-bancolombia";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "replay-sms-dump" });

// imessage-exporter txt block layout (blank-line separated):
//   line 1: timestamp header ("Dec 09, 2025  4:32:26 PM (...)")
//   line 2: sender handle ("85540")
//   line 3+: message body
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

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    throw new Error("usage: bun run scripts/replay-sms-dump.ts <imessage-export-dir>");
  }

  const bodies = loadFromImessageDir(dir);
  log.info({ count: bodies.length, dir, event: "replay_sms_loaded" }, "Loaded SMS bodies");

  const counts = {
    inserted: 0,
    duplicated: 0,
    skipped: 0,
    error: 0,
  };
  const byKind: Record<string, number> = {};
  const errors: Array<{ reason: string; body: string }> = [];

  for (const body of bodies) {
    const parsed = parseSmsBancolombia(body);
    const kind =
      parsed.kind === "skip" || parsed.kind === "needs_review"
        ? `${parsed.kind}:${parsed.reason}`
        : parsed.kind;
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    // Replay script scopes to user 1 (bootstrap).
    const outcome = await ingestParsed(1, parsed);
    counts[outcome.status] += 1;
    if (outcome.status === "error") {
      errors.push({ reason: outcome.reason, body: body.slice(0, 80) });
    }
  }

  log.info({ counts, event: "replay_sms_ingest_outcomes" }, "ingest outcomes");

  log.info({ byKind, event: "replay_sms_by_kind" }, "breakdown by parsed kind");

  if (errors.length > 0) {
    const sample = errors.slice(0, 5);
    log.info({ sample, event: "replay_sms_errors_sample" }, "errors (first 5)");
  }

  // Post-ingest DB summary
  const txStats = await db.execute<{
    source: string;
    kind: string | null;
    c: number;
  }>(sql`
    SELECT source,
           raw_data->>'kind' AS kind,
           COUNT(*)::int AS c
    FROM transactions
    GROUP BY source, raw_data->>'kind'
    ORDER BY c DESC
  `);
  log.info({ txStats, event: "replay_sms_tx_stats" }, "DB transactions by (source, kind)");

  const cpStats = await db.execute<{
    c: number;
    with_category: number;
  }>(sql`
    SELECT COUNT(*)::int AS c,
           COUNT(*) FILTER (WHERE default_category_slug IS NOT NULL)::int AS with_category
    FROM counterparties
  `);
  log.info(
    {
      total: cpStats[0].c,
      withCategory: cpStats[0].with_category,
      event: "replay_sms_counterparty_stats",
    },
    "counterparty totals",
  );

  const topCp = await db.execute<{
    display_name: string;
    hit_count: number;
    aliases: string;
  }>(sql`
    SELECT c.display_name, c.hit_count,
      (SELECT string_agg(a.kind || ':' || a.value, ', ' ORDER BY a.kind)
       FROM counterparty_aliases a WHERE a.counterparty_id = c.id) AS aliases
    FROM counterparties c
    ORDER BY c.hit_count DESC, c.display_name ASC
    LIMIT 10
  `);
  log.info({ topCp, event: "replay_sms_top_counterparties" }, "top 10 counterparties by hit_count");

  const classification = await db.execute<{
    method: string;
    c: number;
  }>(sql`
    SELECT classification_method::text AS method, COUNT(*)::int AS c
    FROM transactions
    GROUP BY classification_method
    ORDER BY c DESC
  `);
  log.info(
    { classification, event: "replay_sms_classification" },
    "classification method breakdown",
  );

  await db.$client.end({ timeout: 1 });
}

main().catch((err) => {
  log.error({ err, event: "replay_sms_failed" }, "replay-sms-dump failed");
  process.exit(1);
});
