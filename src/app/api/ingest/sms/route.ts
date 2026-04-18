import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { accounts, ingestionLogs, transactions } from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";
import {
  parseSmsBancolombia,
  resolveAccountFromLast4,
  type ParseResult,
  type ParsedSms,
  type RoutableAccount,
} from "@/lib/ingestion/sms-bancolombia";
import { keyForParsed } from "@/lib/counterparties/alias-key";
import { resolveWebhookAuth } from "@/lib/webhook-tokens";
import type { ClassificationMethod } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10 * 1024;

// Colombia uses UTC-5 year-round (no DST). Time in SMS is local.
const COP_TIMEZONE_OFFSET = "-05:00";

type IngestOutcome =
  | { status: "inserted"; txId: number }
  | { status: "duplicated" }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

export async function POST(req: Request) {
  const startedAt = new Date();

  const auth = await resolveWebhookAuth({
    authHeader: req.headers.get("authorization"),
    purpose: "sms",
  });
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  let payload: { sender?: unknown; body?: unknown; receivedAt?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sender = typeof payload.sender === "string" ? payload.sender : null;
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const receivedAt = typeof payload.receivedAt === "string" ? payload.receivedAt : null;

  if (!body) {
    return NextResponse.json({ error: "Missing required field: body" }, { status: 400 });
  }

  const parsed = parseSmsBancolombia(body);
  const outcome = await ingestParsed(auth.userId, parsed);

  await db.insert(ingestionLogs).values({
    userId: auth.userId,
    source: "sms",
    status: outcome.status,
    itemsReceived: 1,
    itemsInserted: outcome.status === "inserted" ? 1 : 0,
    itemsDuplicated: outcome.status === "duplicated" ? 1 : 0,
    errorMessage:
      outcome.status === "error" || outcome.status === "skipped" ? outcome.reason : null,
    payload: {
      sender,
      receivedAt,
      body,
      parsed: serializeParsed(parsed),
      outcome,
    },
    startedAt,
    finishedAt: new Date(),
  });

  return NextResponse.json({ ok: true, ...outcome });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST { sender, body, receivedAt? } with Authorization: Bearer <per-user token from /settings/webhooks>",
  });
}

// -----------------------------------------------------------------------------
// Ingestion logic — separated so it's testable in isolation
// -----------------------------------------------------------------------------

export async function ingestParsed(userId: number, parsed: ParseResult): Promise<IngestOutcome> {
  if (parsed.kind === "skip") {
    return { status: "skipped", reason: `parser: ${parsed.reason}` };
  }

  const allAccounts = (await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      metadata: accounts.metadata,
      institution: accounts.institution,
      type: accounts.type,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))) as Array<
    RoutableAccount & { institution: string; type: string }
  >;

  const account = resolveAccountForParsed(parsed, allAccounts);
  if (!account) {
    return {
      status: "error",
      reason: `no account matches for kind=${parsed.kind}`,
    };
  }

  const occurredAt = new Date(
    `${parsed.occurredOn}T${parsed.occurredTime}:00${COP_TIMEZONE_OFFSET}`,
  );
  const { amountCents, descriptionRaw, merchant, categorySlug, method } = buildTxFields(parsed);

  // Counterparty lookup (and auto-create for bre_b). For kinds with toKey,
  // this is the preferred classification path over text-pattern rules.
  const cp = await resolveCounterparty(userId, parsed, db);

  // Purchases and PSE outgoing payments get rule-based classification attempted.
  // Other kinds have hardcoded categories (pago-tc, transferencias, ingresos)
  // or inherit from counterparty (qr_payment, bre_b_transfer).
  let finalCategory = cp.inheritedCategory ?? categorySlug;
  let finalMethod: Exclude<ClassificationMethod, "ai"> = cp.inheritedCategory ? "rule" : method;
  let confidence: number | null = null;
  const shouldAttemptRule =
    !cp.inheritedCategory &&
    (parsed.kind === "purchase" ||
      parsed.kind === "provider_payment_sent" ||
      parsed.kind === "qr_payment");
  if (shouldAttemptRule) {
    const cls = await classifyByRule(userId, {
      descriptionRaw,
      merchant,
    });
    if (cls) {
      finalCategory = cls.categorySlug;
      finalMethod = "rule";
      confidence = cls.confidence;
    } else {
      finalMethod = "unclassified";
    }
  }

  try {
    const result = await db
      .insert(transactions)
      .values({
        userId,
        accountId: account.id,
        occurredAt,
        amountCents,
        currency: parsed.currency,
        descriptionRaw,
        descriptionClean: null,
        merchant,
        categorySlug: finalCategory,
        counterpartyId: cp.counterpartyId,
        classificationMethod: finalMethod,
        classificationConfidence: confidence,
        source: "sms",
        externalId: parsed.externalId,
        rawData: {
          kind: parsed.kind,
          sms: parsed.raw,
        },
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (result.length === 0) return { status: "duplicated" };
    await autoLinkTransaction(userId, result[0].id);
    emit({
      type: "transaction:created",
      id: result[0].id,
      source: "sms",
      timestamp: Date.now(),
    });
    return { status: "inserted", txId: result[0].id };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

type CounterpartyResolution = {
  counterpartyId: number | null;
  inheritedCategory: string | null;
};

/**
 * Resolves (and lazily creates) a counterparty for any kind that carries an
 * identifier: qr_payment, bre_b_transfer, transfer_sent, transfer_received.
 *
 * Lookup is by (alias.kind, alias.value). If the alias does not exist, a new
 * counterparty + alias are inserted atomically in a transaction so we never
 * leave an orphan counterparty if concurrent ingests race.
 *
 * Hit counter bumped on every match/insert.
 */
export async function resolveCounterparty(
  userId: number,
  parsed: ParsedSms,
  database: DB,
): Promise<CounterpartyResolution> {
  const key = keyForParsed(parsed);
  if (!key) return { counterpartyId: null, inheritedCategory: null };

  return database.transaction(async (trx) => {
    const existing = await trx.execute<{
      id: number;
      default_category_slug: string | null;
    }>(sql`
      SELECT c.id, c.default_category_slug
      FROM counterparty_aliases a
      JOIN counterparties c ON c.id = a.counterparty_id
      WHERE a.user_id = ${userId}
        AND a.kind = ${key.kind}::counterparty_key_kind
        AND a.value = ${key.value}
      LIMIT 1
    `);

    if (existing.length > 0) {
      await trx.execute(sql`
        UPDATE counterparties
        SET hit_count = hit_count + 1, last_hit_at = now()
        WHERE user_id = ${userId} AND id = ${existing[0].id}
      `);
      return {
        counterpartyId: existing[0].id,
        inheritedCategory: existing[0].default_category_slug,
      };
    }

    const inserted = await trx.execute<{ id: number }>(sql`
      INSERT INTO counterparties (user_id, display_name, type, hit_count, last_hit_at)
      VALUES (${userId}, ${key.initialDisplayName}, 'unknown', 1, now())
      RETURNING id
    `);
    await trx.execute(sql`
      INSERT INTO counterparty_aliases (user_id, counterparty_id, kind, value)
      VALUES (${userId}, ${inserted[0].id}, ${key.kind}::counterparty_key_kind, ${key.value})
    `);
    return { counterpartyId: inserted[0].id, inheritedCategory: null };
  });
}

function resolveAccountForParsed(
  parsed: ParsedSms,
  allAccounts: Array<RoutableAccount & { institution: string; type: string }>,
): RoutableAccount | null {
  switch (parsed.kind) {
    case "purchase":
      return resolveAccountFromLast4(parsed.cardLast4, parsed.currency, allAccounts);
    case "transfer_sent":
    case "qr_payment":
    case "tc_payment":
    case "provider_payment_sent":
    case "atm_withdrawal":
    case "bre_b_transfer":
      return resolveAccountFromLast4(parsed.fromLast4, parsed.currency, allAccounts);
    case "transfer_received":
      return resolveAccountFromLast4(parsed.toLast4, parsed.currency, allAccounts);
    case "tc_credit_received":
      return resolveAccountFromLast4(parsed.toCardLast4, parsed.currency, allAccounts);
    case "provider_payment": {
      // SMS says "en tu cuenta de Ahorros" — no last4. Default to the single
      // Bancolombia savings account in the matching currency.
      return (
        allAccounts.find(
          (a) =>
            a.institution === "Bancolombia" &&
            a.type === "savings" &&
            a.currency === parsed.currency,
        ) ?? null
      );
    }
  }
}

function buildTxFields(parsed: ParsedSms): {
  amountCents: bigint;
  descriptionRaw: string;
  merchant: string | null;
  categorySlug: string | null;
  method: Exclude<ClassificationMethod, "ai">;
} {
  switch (parsed.kind) {
    case "purchase":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: parsed.merchant,
        merchant: parsed.merchant,
        categorySlug: null, // classifyByRule will fill this
        method: "unclassified",
      };
    case "transfer_sent":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Transferencia${parsed.isQR ? " QR" : ""} a cuenta *${parsed.toAccount}`,
        merchant: null,
        categorySlug: "transferencias",
        method: "manual",
      };
    case "qr_payment":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Pago QR a llave ${parsed.toKey}`,
        merchant: null,
        categorySlug: null,
        method: "unclassified",
      };
    case "tc_payment":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Pago TC *${parsed.toCardLast4}`,
        merchant: null,
        categorySlug: "pago-tc",
        method: "manual",
      };
    case "transfer_received":
      return {
        amountCents: parsed.amountCents,
        descriptionRaw: `Transferencia recibida de ${parsed.senderName}`,
        merchant: parsed.senderName,
        categorySlug: "ingresos",
        method: "manual",
      };
    case "provider_payment":
      return {
        amountCents: parsed.amountCents,
        descriptionRaw: `Pago PROVEEDOR de ${parsed.senderName}`,
        merchant: parsed.senderName,
        categorySlug: "ingresos",
        method: "manual",
      };
    case "provider_payment_sent":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Pago a ${parsed.providerName}`,
        merchant: parsed.providerName,
        categorySlug: null,
        method: "unclassified",
      };
    case "atm_withdrawal":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Retiro ATM ${parsed.atmCode}`,
        merchant: null,
        categorySlug: null,
        method: "unclassified",
      };
    case "tc_credit_received":
      return {
        amountCents: parsed.amountCents,
        descriptionRaw: `Abono de ${parsed.senderName} a TC *${parsed.toCardLast4}`,
        merchant: parsed.senderName,
        categorySlug: "pago-tc",
        method: "manual",
      };
    case "bre_b_transfer":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Transferencia Bre-b a ${parsed.recipientName}`,
        merchant: parsed.recipientName,
        categorySlug: null,
        method: "unclassified",
      };
  }
}

function serializeParsed(parsed: ParseResult): Record<string, unknown> {
  if (parsed.kind === "skip") return { kind: "skip", reason: parsed.reason };
  // Convert bigint to string for JSON storage
  return {
    ...parsed,
    amountCents: parsed.amountCents.toString(),
  };
}
