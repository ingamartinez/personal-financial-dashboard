import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { POST } from "./route";

const TEST_TOKEN = "test-token-vitest-sms-ingest";
// SMS bodies used in tests — we clean up by externalId, not by marker,
// because the externalId is deterministic per (kind, amount, date, ...).
const TEST_EXTERNAL_ID_PREFIX = "bcol-sms:";

function makeRequest(init: {
  body?: string;
  headers?: Record<string, string>;
}) {
  return new Request("http://localhost:3100/api/ingest/sms", {
    method: "POST",
    body: init.body,
    headers: init.headers,
  });
}

async function cleanup() {
  await db.execute(sql`
    DELETE FROM transactions WHERE external_id LIKE ${TEST_EXTERNAL_ID_PREFIX + "%"}
  `);
  await db.execute(sql`DELETE FROM ingestion_logs WHERE source = 'sms'`);
  await db.execute(sql`DELETE FROM counterparties`);
}

function jsonBody(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function authedHeaders() {
  return {
    authorization: `Bearer ${TEST_TOKEN}`,
    "content-type": "application/json",
  };
}

describe("POST /api/ingest/sms", () => {
  beforeEach(() => {
    process.env.INGEST_WEBHOOK_TOKEN = TEST_TOKEN;
  });
  afterEach(cleanup);
  afterAll(async () => {
    delete process.env.INGEST_WEBHOOK_TOKEN;
    await db.$client.end({ timeout: 1 });
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  it("returns 503 when INGEST_WEBHOOK_TOKEN is not configured", async () => {
    delete process.env.INGEST_WEBHOOK_TOKEN;
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: "test" }),
        headers: authedHeaders(),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await POST(makeRequest({ body: jsonBody({ body: "test" }) }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token does not match", async () => {
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: "test" }),
        headers: { authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(
      makeRequest({ body: "not-json", headers: authedHeaders() }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when body field is missing", async () => {
    const res = await POST(
      makeRequest({ body: jsonBody({ sender: "85784" }), headers: authedHeaders() }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 413 on oversized payload", async () => {
    const huge = "x".repeat(20 * 1024);
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: huge }),
        headers: authedHeaders(),
      }),
    );
    expect(res.status).toBe(413);
  });

  // ---------------------------------------------------------------------------
  // Happy path — transaction creation
  // ---------------------------------------------------------------------------

  it("inserts a COP purchase tx and logs success", async () => {
    const body =
      "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ sender: "85784", body }),
        headers: authedHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      status: string;
      txId?: number;
    };
    expect(json.status).toBe("inserted");
    expect(json.txId).toBeGreaterThan(0);

    const rows = await db.execute<{
      account_id: number;
      amount_cents: string;
      currency: string;
      merchant: string;
      source: string;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT account_id, amount_cents, currency, merchant, source, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("sms");
    expect(rows[0].currency).toBe("COP");
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-3545000));
    expect(rows[0].merchant).toBe("DLO*DiDi Food CO Pay");
    // DIDI FOOD rule matches → uber-didi? No — "DIDI FOOD" matches "delivery"
    expect(rows[0].category_slug).toBe("delivery");
    expect(rows[0].classification_method).toBe("rule");
  });

  it("routes USD purchase to Mastercard *7291 (USD) — dual-currency disambiguation", async () => {
    const body =
      "Bancolombia: Compraste USD195,26 en CLAUDE.AI SUBSCRIPTI, el 15/04/2026 a las 01:09. Esta compra esta asociada a T.Cred *7291. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ sender: "85540", body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      currency: string;
      amount_cents: string;
      account_id: number;
    }>(sql`
      SELECT currency, amount_cents, account_id
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(rows[0].currency).toBe("USD");
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-19526));

    // Verify the account is the USD Mastercard, not the COP one
    const accs = await db.execute<{ currency: string; name: string }>(sql`
      SELECT currency, name FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].currency).toBe("USD");
    expect(accs[0].name).toMatch(/Mastercard.*7291.*USD/);
  });

  it("inserts a QR payment as expense from *6126 with unclassified category", async () => {
    const body =
      "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste $92,000.00 por codigo QR desde tu cuenta *6126 a la llave 0091498581 el 15/04/2026 a las 00:20. Con codigo QR es facil y de una. Dudas al 018000912345";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT amount_cents, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-9200000));
    expect(rows[0].category_slug).toBeNull();
    expect(rows[0].classification_method).toBe("unclassified");
  });

  it("inserts a TC payment as pago-tc expense from *6126", async () => {
    const body =
      "Bancolombia: Pagaste $1,320,564 en la tarjeta de credito *7291 desde la cuenta *6126, el 14/04/2026 21:48. ¿Dudas? Llamanos al 018000912345. Estamos cerca.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT amount_cents, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-132056400));
    expect(rows[0].category_slug).toBe("pago-tc");
    expect(rows[0].classification_method).toBe("manual");
  });

  it("inserts a transfer_received as income into Ahorros", async () => {
    const body =
      "Bancolombia: ALEJANDRO, recibiste una transferencia de ESTEBAN LEONARDO SARMIENTO GOMEZ por $100,000.00 en tu cuenta *6126 conectada a la llave 3012998429 el 14/04/26 a las 15:28. Con llaves es de una y gratis. Dudas al 018000912345";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      category_slug: string | null;
      merchant: string | null;
    }>(sql`
      SELECT amount_cents, category_slug, merchant
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(10000000)); // positive income
    expect(rows[0].category_slug).toBe("ingresos");
    expect(rows[0].merchant).toBe("ESTEBAN LEONARDO SARMIENTO GOMEZ");
  });

  it("inserts a bre_b_transfer as expense from *6126 with recipient as merchant", async () => {
    const body =
      "Bancolombia: ALEJANDRO, transferiste $50,000.00 a la llave 3046262677 desde tu cuenta *6126 a MARIA PAZ TORRES CARRILLO el 01/04/26 a las 13:22. Con Bre-b es de una y gratis. Dudas al 018000912345.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      merchant: string | null;
      account_id: number;
      category_slug: string | null;
      classification_method: string;
      description_raw: string;
    }>(sql`
      SELECT amount_cents, merchant, account_id, category_slug, classification_method, description_raw
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-5000000));
    expect(rows[0].merchant).toBe("MARIA PAZ TORRES CARRILLO");
    expect(rows[0].category_slug).toBeNull();
    expect(rows[0].classification_method).toBe("unclassified");
    expect(rows[0].description_raw).toBe(
      "Transferencia Bre-b a MARIA PAZ TORRES CARRILLO",
    );

    const accs = await db.execute<{ name: string; currency: string }>(sql`
      SELECT name, currency FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].name).toBe("Bancolombia Ahorros");
    expect(accs[0].currency).toBe("COP");
  });

  it("inserts a tc_credit_received as positive abono on the TC account", async () => {
    const body =
      "Bancolombia: AIDA MALDONADO hizo un abono por $2,125,092 a tu tarjeta de credito terminada en **2575, el 03/12/2025 13:40. Si tienes dudas, llamanos al 018000931987. Estamos cerca.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      merchant: string | null;
      account_id: number;
      category_slug: string | null;
      classification_method: string;
      description_raw: string;
    }>(sql`
      SELECT amount_cents, merchant, account_id, category_slug, classification_method, description_raw
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(212509200)); // positive — reduces TC debt
    expect(rows[0].merchant).toBe("AIDA MALDONADO");
    expect(rows[0].category_slug).toBe("pago-tc");
    expect(rows[0].classification_method).toBe("manual");
    expect(rows[0].description_raw).toBe("Abono de AIDA MALDONADO a TC *2575");

    // Routes to the COP credit card with last4 2575
    const accs = await db.execute<{ name: string; type: string }>(sql`
      SELECT name, type FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].type).toBe("credit_card");
    expect(accs[0].name).toMatch(/2575/);
  });

  it("inserts an atm_withdrawal as expense from the savings linked to the debit card", async () => {
    const body =
      "Bancolombia: Retiraste $100.000,00 en 43AVENIDA de tu T.Deb **1802 el 19/02/2026 a las 16:36. Si tienes dudas, llamanos al 6045109095. Estamos cerca";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      merchant: string | null;
      account_id: number;
      category_slug: string | null;
      classification_method: string;
      description_raw: string;
    }>(sql`
      SELECT amount_cents, merchant, account_id, category_slug, classification_method, description_raw
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-10000000));
    expect(rows[0].merchant).toBeNull();
    expect(rows[0].category_slug).toBeNull();
    expect(rows[0].classification_method).toBe("unclassified");
    expect(rows[0].description_raw).toBe("Retiro ATM 43AVENIDA");

    const accs = await db.execute<{ name: string; currency: string }>(sql`
      SELECT name, currency FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].name).toBe("Bancolombia Ahorros");
    expect(accs[0].currency).toBe("COP");
  });

  it("inserts a provider_payment_sent (PSE) as expense from *6126", async () => {
    const body =
      "Bancolombia: Pagaste $430,997.00 a EMPRESAS PUBLICAS DE MEDELLIN desde tu producto *6126 el 13/02/2026 10:39:06. ¿Dudas? Llamanos al 6045109095. Estamos cerca";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      amount_cents: string;
      merchant: string | null;
      account_id: number;
      classification_method: string;
    }>(sql`
      SELECT amount_cents, merchant, account_id, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(-43099700));
    expect(rows[0].merchant).toBe("EMPRESAS PUBLICAS DE MEDELLIN");

    // Routes to the COP savings account that owns last4 6126
    const accs = await db.execute<{ name: string; currency: string }>(sql`
      SELECT name, currency FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].currency).toBe("COP");
    expect(accs[0].name).toBe("Bancolombia Ahorros");
  });

  it("inserts a provider_payment into Bancolombia Ahorros (no last-4 in SMS)", async () => {
    const body =
      "Bancolombia: Recibiste un pago PROVEEDOR de PEXTO COLOMBIA por $6,000,000.00 en tu cuenta de Ahorros el 14/04/2026 a las 21:43. Si tienes dudas, llamanos al 018000931987. A tu lado siempre.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{ amount_cents: string; account_id: number }>(sql`
      SELECT amount_cents, account_id FROM transactions WHERE id = ${json.txId!}
    `);
    expect(BigInt(rows[0].amount_cents)).toBe(BigInt(600000000));

    const accs = await db.execute<{ name: string }>(sql`
      SELECT name FROM accounts WHERE id = ${rows[0].account_id}
    `);
    expect(accs[0].name).toBe("Bancolombia Ahorros");
  });

  // ---------------------------------------------------------------------------
  // Skip cases
  // ---------------------------------------------------------------------------

  it("skips failed purchases without creating tx", async () => {
    const body =
      "Bancolombia: tu compra con T.cred *2575 por $92.000,00 no fue exitosa, los datos de tu t.cred estan incorrectos. 09:05 13/04/2026. ¿Dudas? 018000912345";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; reason?: string };
    expect(json.status).toBe("skipped");
    expect(json.reason).toContain("failed");

    const logs = await db.execute<{ status: string }>(sql`
      SELECT status FROM ingestion_logs WHERE source = 'sms' ORDER BY id DESC LIMIT 1
    `);
    expect(logs[0].status).toBe("skipped");
  });

  it("skips non-transactional notifications", async () => {
    const body =
      "Bancolombia: Listo. Actualizaste tu informacion personal en Sucursal Virtual, el 15/04/2026 a las 16:25. ¿No fuiste tu? Llamanos al 6045109000. A tu lado en cada paso.";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; reason?: string };
    expect(json.status).toBe("skipped");
    expect(json.reason).toContain("non_transactional");
  });

  it("skips unknown SMS formats", async () => {
    const body = "Bancolombia: algo completamente desconocido que no matchea ningun patron";
    const res = await POST(
      makeRequest({
        body: jsonBody({ body }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; reason?: string };
    expect(json.status).toBe("skipped");
    expect(json.reason).toContain("unknown");
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it("returns 'duplicated' on second POST of the same SMS", async () => {
    const body =
      "Bancolombia: Compraste COP71.950,00 en RAPPI COLOMBIA*DL, el 15/04/2026 a las 12:50. Esta compra esta asociada a T.Cred *2575. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";

    const first = await POST(
      makeRequest({ body: jsonBody({ body }), headers: authedHeaders() }),
    );
    const firstJson = (await first.json()) as { status: string };
    expect(firstJson.status).toBe("inserted");

    const second = await POST(
      makeRequest({ body: jsonBody({ body }), headers: authedHeaders() }),
    );
    const secondJson = (await second.json()) as { status: string };
    expect(secondJson.status).toBe("duplicated");

    // Only 1 transaction row should exist for this externalId
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM transactions
      WHERE merchant = 'RAPPI COLOMBIA*DL' AND source = 'sms'
    `);
    expect(rows[0].c).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Counterparty lookup + auto-create (qr_payment + bre_b_transfer)
  // ---------------------------------------------------------------------------

  const QR_BODY =
    "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste $92,000.00 por codigo QR desde tu cuenta *6126 a la llave 0091498581 el 15/04/2026 a las 00:20. Con codigo QR es facil y de una. Dudas al 018000912345";
  const QR_KEY = "0091498581";

  const BREB_BODY =
    "Bancolombia: ALEJANDRO, transferiste $50,000.00 a la llave 3046262677 desde tu cuenta *6126 a MARIA PAZ TORRES CARRILLO el 01/04/26 a las 13:22. Con Bre-b es de una y gratis. Dudas al 018000912345.";
  const BREB_KEY = "3046262677";

  it("QR with new key does NOT auto-create counterparty; tx unclassified", async () => {
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: QR_BODY }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const txRows = await db.execute<{
      counterparty_id: number | null;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT counterparty_id, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(txRows[0].counterparty_id).toBeNull();
    expect(txRows[0].category_slug).toBeNull();
    expect(txRows[0].classification_method).toBe("unclassified");

    const cpRows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM counterparties WHERE key = ${QR_KEY}
    `);
    expect(cpRows[0].c).toBe(0);
  });

  it("QR with existing counterparty (no default category) links but stays unclassified", async () => {
    await db.execute(sql`
      INSERT INTO counterparties (key, display_name, type)
      VALUES (${QR_KEY}, 'Panadería del Barrio', 'merchant')
    `);
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: QR_BODY }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      counterparty_id: number | null;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT counterparty_id, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(rows[0].counterparty_id).not.toBeNull();
    expect(rows[0].category_slug).toBeNull();
    expect(rows[0].classification_method).toBe("unclassified");

    const cpRows = await db.execute<{ hit_count: number }>(sql`
      SELECT hit_count FROM counterparties WHERE key = ${QR_KEY}
    `);
    expect(cpRows[0].hit_count).toBe(1);
  });

  it("QR with existing counterparty that has default_category inherits + method=rule", async () => {
    await db.execute(sql`
      INSERT INTO counterparties (key, display_name, type, default_category_slug)
      VALUES (${QR_KEY}, 'Panadería del Barrio', 'merchant', 'alimentacion')
    `);
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: QR_BODY }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      counterparty_id: number | null;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT counterparty_id, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(rows[0].counterparty_id).not.toBeNull();
    expect(rows[0].category_slug).toBe("alimentacion");
    expect(rows[0].classification_method).toBe("rule");
  });

  it("Bre-b with new key auto-creates counterparty with recipient as display_name", async () => {
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: BREB_BODY }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const cpRows = await db.execute<{
      display_name: string;
      type: string;
      hit_count: number;
      default_category_slug: string | null;
    }>(sql`
      SELECT display_name, type, hit_count, default_category_slug
      FROM counterparties WHERE key = ${BREB_KEY}
    `);
    expect(cpRows).toHaveLength(1);
    expect(cpRows[0].display_name).toBe("MARIA PAZ TORRES CARRILLO");
    expect(cpRows[0].type).toBe("unknown");
    expect(cpRows[0].hit_count).toBe(1);
    expect(cpRows[0].default_category_slug).toBeNull();

    const txRows = await db.execute<{
      counterparty_id: number | null;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT counterparty_id, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(txRows[0].counterparty_id).not.toBeNull();
    expect(txRows[0].category_slug).toBeNull();
    expect(txRows[0].classification_method).toBe("unclassified");
  });

  it("Bre-b repeat SMS increments hit_count without duplicating counterparty", async () => {
    const first = await POST(
      makeRequest({ body: jsonBody({ body: BREB_BODY }), headers: authedHeaders() }),
    );
    expect((await first.json()).status).toBe("inserted");

    // Second SMS with different amount/time — same recipient key
    const BREB_BODY_2 =
      "Bancolombia: ALEJANDRO, transferiste $25,000.00 a la llave 3046262677 desde tu cuenta *6126 a MARIA PAZ TORRES CARRILLO el 02/04/26 a las 09:10. Con Bre-b es de una y gratis. Dudas al 018000912345.";
    const second = await POST(
      makeRequest({ body: jsonBody({ body: BREB_BODY_2 }), headers: authedHeaders() }),
    );
    expect((await second.json()).status).toBe("inserted");

    const cpRows = await db.execute<{ c: number; hit_count: number }>(sql`
      SELECT COUNT(*)::int AS c, MAX(hit_count) AS hit_count
      FROM counterparties WHERE key = ${BREB_KEY}
    `);
    expect(cpRows[0].c).toBe(1);
    expect(cpRows[0].hit_count).toBe(2);
  });

  it("Bre-b with existing counterparty + default_category inherits on new tx", async () => {
    await db.execute(sql`
      INSERT INTO counterparties (key, display_name, type, default_category_slug)
      VALUES (${BREB_KEY}, 'Maria Paz', 'person', 'transferencias')
    `);
    const res = await POST(
      makeRequest({
        body: jsonBody({ body: BREB_BODY }),
        headers: authedHeaders(),
      }),
    );
    const json = (await res.json()) as { status: string; txId?: number };
    expect(json.status).toBe("inserted");

    const rows = await db.execute<{
      counterparty_id: number | null;
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT counterparty_id, category_slug, classification_method
      FROM transactions WHERE id = ${json.txId!}
    `);
    expect(rows[0].counterparty_id).not.toBeNull();
    expect(rows[0].category_slug).toBe("transferencias");
    expect(rows[0].classification_method).toBe("rule");

    // Upsert preserves the original display_name (does not overwrite with SMS recipient)
    const cpRows = await db.execute<{ display_name: string; hit_count: number }>(sql`
      SELECT display_name, hit_count FROM counterparties WHERE key = ${BREB_KEY}
    `);
    expect(cpRows[0].display_name).toBe("Maria Paz");
    expect(cpRows[0].hit_count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // GET handler
  // ---------------------------------------------------------------------------
});
