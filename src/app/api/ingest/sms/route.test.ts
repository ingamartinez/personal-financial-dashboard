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
  // GET handler
  // ---------------------------------------------------------------------------
});
