/**
 * One-shot discovery: list every unique `From:` address seen in a user's
 * Gmail per gateway DOMAIN, over a given time window.
 *
 * Used to validate and extend `src/lib/gmail/registry.ts` with the real
 * senders observed in a user's inbox. Rerun whenever a bank rotates its
 * notification domain.
 *
 * IMPORTANT: uses DOMAIN-level queries (`from:@<domain>`) because Gmail's
 * `from:<keyword>` matcher does NOT reliably match substrings embedded in
 * hostnames — e.g. `from:bancolombia` misses emails whose sender is
 * `@an.notificacionesbancolombia.com`. Domain queries are the only way
 * to get an accurate census.
 *
 * Usage (on the prod droplet, with env sourced):
 *   cd /srv/findash/app/current
 *   sudo -u findash bash -c \
 *     'set -a; source /srv/findash/env/findash.env; set +a; \
 *      bun run scripts/gmail-sender-discovery.ts 1 2026-01-01'
 */

import { createDecipheriv } from "node:crypto";
import postgres from "postgres";
import { google } from "googleapis";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// Cap the number of messages we fetch metadata for per domain; we only
// need a representative sample of the senders, not an exhaustive audit.
const MAX_METADATA_FETCHES_PER_DOMAIN = 200;

// Seed domains to probe. Grouped by gateway so the output is organized.
// This list comes from PLAN.md + a first-pass keyword-search discovery
// that surfaced the wider constellation of domains each gateway uses.
// When a new domain surfaces in prod, add it here and rerun.
const DOMAINS_BY_GATEWAY: Record<string, string[]> = {
  bancolombia: [
    "bancolombia.com.co",
    "bancolombia.com",
    "an.notificacionesbancolombia.com",
    "notificacionesbancolombia.com",
    "extractos.documentosbancolombia.com",
    "documentosbancolombia.com",
    "infobancolombia.com",
    "tubienestarfinanciero.infobancolombia.com",
    "correobancolombia.com",
    "mercadeo.correobancolombia.com",
  ],
  mercado_pago: [
    "mercadopago.com",
    "mercadopago.com.co",
    "a.mercadopago.com",
    "email.mercadopago.com",
    "r.mercadopago.com",
  ],
  mercado_libre: [
    "mercadolibre.com",
    "mercadolibre.com.co",
    "a.mercadolibre.com.co",
    "r.mercadolibre.com.co",
    "no-responder.mercadolibre.com",
  ],
  payu: ["payu.com", "payulatam.com", "payu.com.co"],
  wompi: ["wompi.co"],
  apple: ["email.apple.com", "insideapple.apple.com", "id.apple.com", "apple.com"],
  paypal: ["paypal.com", "intl.paypal.com", "e.paypal.com"],
};

// Human-readable CLI output. We deliberately bypass the Pino logger here
// because a discovery run's value IS the formatted table a human reads,
// not structured events — piping JSON through pino-pretty adds a hop with
// no benefit. `process.stdout.write` / `process.stderr.write` satisfy the
// `no-console` rule while keeping the output clean.
function out(line = ""): void {
  process.stdout.write(line + "\n");
}
function err(line: string): void {
  process.stderr.write(line + "\n");
}

function usage(): never {
  err("usage: gmail-sender-discovery.ts <userId> <sinceISODate>");
  err("example: gmail-sender-discovery.ts 1 2026-01-01");
  process.exit(2);
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    err(`[discovery] ${name} must be set (source /srv/findash/env/findash.env)`);
    process.exit(1);
  }
  return v;
}

// AES-256-GCM decrypt matching src/lib/crypto/symmetric.ts layout:
// base64(iv || ciphertext || authTag).
function decrypt(payload: string, envName: string): string {
  const key = Buffer.from(mustEnv(envName), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${envName} decodes to ${key.length} bytes; expected ${KEY_BYTES}`);
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) throw new Error("payload too short");
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

async function countForQuery(
  gmail: ReturnType<typeof google.gmail>,
  q: string,
  maxPages = 50,
): Promise<string[]> {
  // Returns ALL message ids matching the query up to `maxPages` * 500.
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 500,
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return ids;
}

async function main(): Promise<void> {
  const [userIdArg, sinceIsoArg] = process.argv.slice(2);
  if (!userIdArg || !sinceIsoArg) usage();
  const userId = Number.parseInt(userIdArg, 10);
  if (!Number.isInteger(userId) || userId <= 0) usage();
  const since = new Date(sinceIsoArg);
  if (Number.isNaN(since.getTime())) usage();
  const sinceUnix = Math.floor(since.getTime() / 1000);

  const sql = postgres({
    host: "/var/run/postgresql",
    database: process.env.PGDATABASE ?? "findash",
  });

  try {
    const rows = await sql<
      Array<{
        id: number;
        gmail_email: string;
        access_token_enc: string;
        refresh_token_enc: string;
        access_token_expires_at: Date;
        scopes: string[];
      }>
    >`
      SELECT id, gmail_email, access_token_enc, refresh_token_enc,
             access_token_expires_at, scopes
      FROM gmail_connections
      WHERE user_id = ${userId} AND status = 'active' AND deleted_at IS NULL
      LIMIT 1
    `;

    if (rows.length === 0) {
      err(`[discovery] no active gmail_connections for user_id=${userId}`);
      process.exit(1);
    }
    const row = rows[0];

    const oauth = new google.auth.OAuth2(
      mustEnv("AUTH_GOOGLE_ID"),
      mustEnv("AUTH_GOOGLE_SECRET"),
      mustEnv("GMAIL_OAUTH_REDIRECT_URI"),
    );
    oauth.setCredentials({
      access_token: decrypt(row.access_token_enc, "GMAIL_TOKEN_ENCRYPTION_KEY"),
      refresh_token: decrypt(row.refresh_token_enc, "GMAIL_TOKEN_ENCRYPTION_KEY"),
      expiry_date: new Date(row.access_token_expires_at).getTime(),
      scope: row.scopes.join(" "),
      token_type: "Bearer",
    });
    const gmail = google.gmail({ version: "v1", auth: oauth });

    out(`# gmail sender discovery (domain-level)`);
    out(`# user_id=${userId} gmail=${row.gmail_email}`);
    out(`# since=${sinceIsoArg} (unix=${sinceUnix})`);
    out();

    for (const [gateway, domains] of Object.entries(DOMAINS_BY_GATEWAY)) {
      out(`=== ${gateway.toUpperCase()} ===`);
      for (const domain of domains) {
        const q = `from:(@${domain}) after:${sinceUnix}`;
        const ids = await countForQuery(gmail, q);
        if (ids.length === 0) {
          out(`  @${domain}: 0`);
          continue;
        }

        // Fetch metadata for a sample to enumerate unique full addresses.
        const sample = ids.slice(0, MAX_METADATA_FETCHES_PER_DOMAIN);
        const counts = new Map<string, number>();
        for (const id of sample) {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From"],
          });
          const header = msg.data.payload?.headers?.find((h) => h.name === "From");
          if (!header?.value) continue;
          counts.set(extractEmail(header.value), (counts.get(extractEmail(header.value)) ?? 0) + 1);
        }

        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const truncSuffix = ids.length > sample.length ? ` (sampled ${sample.length})` : "";
        out(`  @${domain}: ${ids.length} msgs${truncSuffix}`);
        for (const [email, count] of sorted) {
          out(`    ${count.toString().padStart(4)}  ${email}`);
        }
      }
      out();
    }
  } finally {
    await sql.end();
  }
}

await main();
process.exit(0);
