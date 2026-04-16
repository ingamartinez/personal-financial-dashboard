import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { accounts, ingestionLogs, transactions } from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";
import {
  parseSmsBancolombia,
  resolveAccountFromLast4,
  type ParseResult,
  type ParsedSms,
  type RoutableAccount,
} from "@/lib/ingestion/sms-bancolombia";

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

  const expectedToken = process.env.INGEST_WEBHOOK_TOKEN;
  if (!expectedToken) {
    return NextResponse.json(
      { error: "INGEST_WEBHOOK_TOKEN not configured" },
      { status: 503 },
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!providedToken || providedToken !== expectedToken) {
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
  const receivedAt =
    typeof payload.receivedAt === "string" ? payload.receivedAt : null;

  if (!body) {
    return NextResponse.json(
      { error: "Missing required field: body" },
      { status: 400 },
    );
  }

  const parsed = parseSmsBancolombia(body);
  const outcome = await ingestParsed(parsed);

  await db.insert(ingestionLogs).values({
    source: "sms",
    status: outcome.status,
    itemsReceived: 1,
    itemsInserted: outcome.status === "inserted" ? 1 : 0,
    itemsDuplicated: outcome.status === "duplicated" ? 1 : 0,
    errorMessage:
      outcome.status === "error" || outcome.status === "skipped"
        ? outcome.reason
        : null,
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
    hint: "POST { sender, body, receivedAt? } with Authorization: Bearer <INGEST_WEBHOOK_TOKEN>",
  });
}

// -----------------------------------------------------------------------------
// Ingestion logic — separated so it's testable in isolation
// -----------------------------------------------------------------------------

export async function ingestParsed(parsed: ParseResult): Promise<IngestOutcome> {
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
    .from(accounts)) as Array<
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
  const { amountCents, descriptionRaw, merchant, categorySlug, method } =
    buildTxFields(parsed);

  // Counterparty lookup (and auto-create for bre_b). For kinds with toKey,
  // this is the preferred classification path over text-pattern rules.
  const cp = await resolveCounterparty(parsed, db);

  // Purchases and PSE outgoing payments get rule-based classification attempted.
  // Other kinds have hardcoded categories (pago-tc, transferencias, ingresos)
  // or inherit from counterparty (qr_payment, bre_b_transfer).
  let finalCategory = cp.inheritedCategory ?? categorySlug;
  let finalMethod: "rule" | "manual" | "unclassified" =
    cp.inheritedCategory ? "rule" : method;
  let confidence: number | null = null;
  if (parsed.kind === "purchase" || parsed.kind === "provider_payment_sent") {
    const cls = await classifyByRule({
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
 * For kinds that carry a counterparty key (qr_payment, bre_b_transfer):
 * - qr_payment: SELECT only. If no counterparty exists, return nulls — user
 *   will register it manually from the UI the first time.
 * - bre_b_transfer: UPSERT by key, pre-filling display_name from the SMS
 *   recipient. Always returns a counterparty id; inheritedCategory only set
 *   if the counterparty already had a default_category_slug.
 *
 * Hit counter is bumped on every match/insert. Uses ON CONFLICT for race-safe
 * auto-create under concurrent SMS bursts.
 */
export async function resolveCounterparty(
  parsed: ParsedSms,
  database: DB,
): Promise<CounterpartyResolution> {
  if (parsed.kind !== "qr_payment" && parsed.kind !== "bre_b_transfer") {
    return { counterpartyId: null, inheritedCategory: null };
  }

  const key = parsed.toKey;

  if (parsed.kind === "bre_b_transfer") {
    const rows = await database.execute<{
      id: number;
      default_category_slug: string | null;
    }>(sql`
      INSERT INTO counterparties (key, display_name, type, hit_count, last_hit_at)
      VALUES (${key}, ${parsed.recipientName}, 'unknown', 1, now())
      ON CONFLICT (key) DO UPDATE
        SET hit_count = counterparties.hit_count + 1,
            last_hit_at = now(),
            updated_at = now()
      RETURNING id, default_category_slug
    `);
    const row = rows[0];
    return {
      counterpartyId: row.id,
      inheritedCategory: row.default_category_slug,
    };
  }

  // qr_payment — SELECT only, no auto-create
  const existing = await database.execute<{
    id: number;
    default_category_slug: string | null;
  }>(sql`
    SELECT id, default_category_slug FROM counterparties WHERE key = ${key}
  `);
  if (existing.length === 0) {
    return { counterpartyId: null, inheritedCategory: null };
  }
  await database.execute(sql`
    UPDATE counterparties
    SET hit_count = hit_count + 1, last_hit_at = now()
    WHERE id = ${existing[0].id}
  `);
  return {
    counterpartyId: existing[0].id,
    inheritedCategory: existing[0].default_category_slug,
  };
}

function resolveAccountForParsed(
  parsed: ParsedSms,
  allAccounts: Array<RoutableAccount & { institution: string; type: string }>,
): RoutableAccount | null {
  switch (parsed.kind) {
    case "purchase":
      return resolveAccountFromLast4(
        parsed.cardLast4,
        parsed.currency,
        allAccounts,
      );
    case "transfer_sent":
    case "qr_payment":
    case "tc_payment":
    case "provider_payment_sent":
    case "atm_withdrawal":
    case "bre_b_transfer":
      return resolveAccountFromLast4(
        parsed.fromLast4,
        parsed.currency,
        allAccounts,
      );
    case "transfer_received":
      return resolveAccountFromLast4(
        parsed.toLast4,
        parsed.currency,
        allAccounts,
      );
    case "tc_credit_received":
      return resolveAccountFromLast4(
        parsed.toCardLast4,
        parsed.currency,
        allAccounts,
      );
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
  method: "rule" | "manual" | "unclassified";
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
