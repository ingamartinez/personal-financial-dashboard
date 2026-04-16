import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { ingestParsed } from "../src/app/api/ingest/sms/route";
import { parseSmsBancolombia } from "../src/lib/ingestion/sms-bancolombia";

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
  console.log(`Loaded ${bodies.length} SMS bodies from ${dir}`);

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
    const kind = parsed.kind === "skip" ? `skip:${parsed.reason}` : parsed.kind;
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    const outcome = await ingestParsed(parsed);
    counts[outcome.status] += 1;
    if (outcome.status === "error") {
      errors.push({ reason: outcome.reason, body: body.slice(0, 80) });
    }
  }

  console.log("\n## Ingest outcomes");
  console.log(`inserted:   ${counts.inserted}`);
  console.log(`duplicated: ${counts.duplicated}`);
  console.log(`skipped:    ${counts.skipped}`);
  console.log(`error:      ${counts.error}`);

  console.log("\n## By parsed kind");
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`${k.padEnd(30)} ${v}`);
  }

  if (errors.length > 0) {
    console.log("\n## Errors (first 5)");
    for (const e of errors.slice(0, 5)) {
      console.log(`  ${e.reason}: ${e.body}…`);
    }
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
  console.log("\n## DB transactions by (source, kind)");
  for (const r of txStats) {
    console.log(`${r.source.padEnd(12)} ${(r.kind ?? "-").padEnd(25)} ${r.c}`);
  }

  const cpStats = await db.execute<{
    c: number;
    with_category: number;
  }>(sql`
    SELECT COUNT(*)::int AS c,
           COUNT(*) FILTER (WHERE default_category_slug IS NOT NULL)::int AS with_category
    FROM counterparties
  `);
  console.log(
    `\n## Counterparties: ${cpStats[0].c} total, ${cpStats[0].with_category} with default category`,
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
  console.log("\n## Top 10 counterparties by hit_count");
  for (const r of topCp) {
    console.log(`  [${r.hit_count}] ${r.display_name.padEnd(40)} [${r.aliases}]`);
  }

  const classification = await db.execute<{
    method: string;
    c: number;
  }>(sql`
    SELECT classification_method::text AS method, COUNT(*)::int AS c
    FROM transactions
    GROUP BY classification_method
    ORDER BY c DESC
  `);
  console.log("\n## Classification method breakdown");
  for (const r of classification) {
    console.log(`${r.method.padEnd(15)} ${r.c}`);
  }

  await db.$client.end({ timeout: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
