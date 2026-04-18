import { describe, expect, it } from "vitest";
import { extractTransactionsFromImage } from "./ocr";

function anthropicResponse(transactions: unknown[]): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify({ transactions }) }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function mockFetch(responseJson: unknown): typeof fetch {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return impl;
}

const commonOpts = {
  imageBase64: "ZmFrZQ==",
  mediaType: "image/png" as const,
  accountId: 42,
  apiKey: "test-key",
};

describe("extractTransactionsFromImage — sign_token post-processing", () => {
  it("uses sign_token as source of truth even when amount sign agrees", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse([
        { date: "2026-04-16", description: "PAGO QR", amount: -28000, sign_token: "-$" },
      ]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows[0].amountCents).toBe(BigInt(-2800000));
  });

  it("fixes a flipped sign when sign_token disagrees with amount", async () => {
    // Model wrote amount=-100 (negative) but the literal token it saw was "$"
    // (income). sign_token should win — row becomes +100.
    const fetchImpl = mockFetch(
      anthropicResponse([
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: -100,
          sign_token: "$",
        },
      ]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows[0].amountCents).toBe(BigInt(10000));
  });

  it("fixes a mirrored flip (positive amount + '-$' token → negative)", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse([
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: 100,
          sign_token: "-$",
        },
      ]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows[0].amountCents).toBe(BigInt(-10000));
  });

  it("falls back to raw amount sign when sign_token is missing (backwards compat)", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse([{ date: "2026-04-16", description: "PAYU*CINEMARK", amount: -25.54 }]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows[0].amountCents).toBe(BigInt(-2554));
  });

  it("handles the Bancolombia mixed-sign batch correctly end-to-end", async () => {
    // Reproduces issue #176 — 4 rows with mixed direction. With sign_token
    // echoed correctly by the model, all 4 land with correct signs.
    const fetchImpl = mockFetch(
      anthropicResponse([
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: 101,
          sign_token: "$",
        },
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: -100,
          sign_token: "-$",
        },
        {
          date: "2026-04-16",
          description: "PAGO QR LA MARQUESA M",
          amount: -28000,
          sign_token: "-$",
        },
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: 100,
          sign_token: "$",
        },
      ]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows.map((row) => row.amountCents)).toEqual([
      BigInt(10100),
      BigInt(-10000),
      BigInt(-2800000),
      BigInt(10000),
    ]);
  });

  it("skips rows with zero amount", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse([{ date: "2026-04-16", description: "FOO", amount: 0, sign_token: "$" }]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it("generates distinct externalIds when same (date, amount, description) repeats", async () => {
    // Two identical transfers on the same day — same amount, same desc, same sign.
    // Dedup inside a single OCR call is handled via positionInDay in the hash.
    const fetchImpl = mockFetch(
      anthropicResponse([
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: 100,
          sign_token: "$",
        },
        {
          date: "2026-04-16",
          description: "TRANSFERENCIA CTA SUC VIRTUAL",
          amount: 100,
          sign_token: "$",
        },
      ]),
    );
    const r = await extractTransactionsFromImage({ ...commonOpts, fetchImpl });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].externalId).not.toBe(r.rows[1].externalId);
  });
});
