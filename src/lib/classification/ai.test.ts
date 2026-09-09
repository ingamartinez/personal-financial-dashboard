// #809: unit tests for the proposedCategory sanitization in classifyBatchWithAi.
// Uses a fake fetch (same pattern as anthropic-client.test.ts) so no network
// call is made and no API key is required.

import { describe, expect, it, vi } from "vitest";
import { classifyBatchWithAi } from "./ai";

function fakeMessageResponse(payload: unknown): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function fakeFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(fakeMessageResponse(payload)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const CATEGORIES = [
  { slug: "vivienda", name: "Vivienda" },
  { slug: "gasolina", name: "Gasolina", parentSlug: "transporte" },
];

describe("classifyBatchWithAi — proposedCategory sanitization", () => {
  it("passes through a proposedCategory whose parentSlug is a real category", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "CLINICA VETERINARIA", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [
          {
            id: 1,
            categorySlug: null,
            confidence: 85,
            proposedCategory: { name: "Mascotas", parentSlug: "vivienda" },
          },
        ],
      }),
    });

    expect(result.classifications[0]?.proposedCategory).toEqual({
      name: "Mascotas",
      parentSlug: "vivienda",
    });
  });

  it("nulls out a proposedCategory.parentSlug that isn't a real category for this user", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "CLINICA VETERINARIA", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [
          {
            id: 1,
            categorySlug: null,
            confidence: 85,
            proposedCategory: { name: "Mascotas", parentSlug: "no-such-category" },
          },
        ],
      }),
    });

    expect(result.classifications[0]?.proposedCategory).toEqual({
      name: "Mascotas",
      parentSlug: null,
    });
  });

  it("returns null for classifications with no proposedCategory field", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "NETFLIX", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [{ id: 1, categorySlug: "vivienda", confidence: 90 }],
      }),
    });

    expect(result.classifications[0]?.proposedCategory).toBeNull();
  });

  it("still sanitizes categorySlug against the valid set as before (regression)", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "SOMETHING", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [{ id: 1, categorySlug: "not-a-real-slug", confidence: 90 }],
      }),
    });

    expect(result.classifications[0]?.categorySlug).toBeNull();
  });
});

// #812: two-layer defense against the AI ever targeting a system-owned
// category ("adjustments" — reserved for reconciliation balance-adjustment
// plugs). Mirrors the existing top-level-parent-guard test shape above.
describe("classifyBatchWithAi — system-owned category guard (#812)", () => {
  const CATEGORIES_WITH_ADJUSTMENTS = [
    ...CATEGORIES,
    { slug: "adjustments", name: "Ajustes de saldo" },
  ];

  it("layer 1: never offers 'adjustments' (or its name) in the system prompt", async () => {
    const capturingFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            fakeMessageResponse({
              classifications: [{ id: 1, categorySlug: "vivienda", confidence: 90 }],
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "SOME MERCHANT", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES_WITH_ADJUSTMENTS,
      apiKey: "test-key",
      fetchImpl: capturingFetch,
    });

    expect(capturingFetch).toHaveBeenCalled();
    const [, init] = vi.mocked(capturingFetch).mock.calls[0]!;
    const body = String((init as RequestInit | undefined)?.body ?? "");
    expect(body).not.toContain("adjustments");
    expect(body).not.toContain("Ajustes de saldo");
  });

  it("layer 2: rejects categorySlug='adjustments' from the model even if it were offered", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "SOME MERCHANT", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES_WITH_ADJUSTMENTS,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [{ id: 1, categorySlug: "adjustments", confidence: 95 }],
      }),
    });

    expect(result.classifications[0]?.categorySlug).toBeNull();
  });

  it("layer 2: nulls out a proposedCategory.parentSlug of 'adjustments' even though it is top-level", async () => {
    const result = await classifyBatchWithAi({
      transactions: [
        { id: 1, description: "SOME MERCHANT", amountCents: BigInt(-5000), currency: "COP" },
      ],
      categories: CATEGORIES_WITH_ADJUSTMENTS,
      apiKey: "test-key",
      fetchImpl: fakeFetch({
        classifications: [
          {
            id: 1,
            categorySlug: null,
            confidence: 85,
            proposedCategory: { name: "Reconciliation Sub", parentSlug: "adjustments" },
          },
        ],
      }),
    });

    expect(result.classifications[0]?.proposedCategory).toEqual({
      name: "Reconciliation Sub",
      parentSlug: null,
    });
  });
});

// #816 §1: the specificity instruction must be conditional on evidence in the
// description, not unconditional — an unconditional "prefer subcategories"
// instruction led the AI to answer "transferencia-persona" for generic QR
// transfers that carry no signal about the counterparty, contradicting 91
// manual + 81 rule-engine decisions for the parent "transferencias".
describe("classifyBatchWithAi — system prompt specificity is conditional on evidence (#816)", () => {
  function captureSystemPrompt(): { fetchImpl: typeof fetch; getBody: () => string } {
    let capturedBody = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify(
          fakeMessageResponse({
            classifications: [{ id: 1, categorySlug: "vivienda", confidence: 90 }],
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, getBody: () => capturedBody };
  }

  it("tells the model to fall back to the parent when the description doesn't distinguish it from its children", async () => {
    const { fetchImpl, getBody } = captureSystemPrompt();

    await classifyBatchWithAi({
      transactions: [
        {
          id: 1,
          description: "Transferencia QR a cuenta *1234",
          amountCents: BigInt(-5000),
          currency: "COP",
        },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl,
    });

    const body = getBody();
    expect(body).toContain("NO signal that distinguishes a subcategory from its parent");
    expect(body).toContain("pick the PARENT category instead of guessing which child applies");
  });

  it("still tells the model to prefer a specific subcategory when the description does support it", async () => {
    const { fetchImpl, getBody } = captureSystemPrompt();

    await classifyBatchWithAi({
      transactions: [
        {
          id: 1,
          description: "Transferencia QR a cuenta *1234",
          amountCents: BigInt(-5000),
          currency: "COP",
        },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl,
    });

    const body = getBody();
    expect(body).toContain("prefer the matching subcategory over its parent");
    expect(body).toContain("restaurantes");
    expect(body).toContain("alimentacion");
    expect(body).toContain(
      "Do not default to the parent out of caution when the description DOES point to a specific subcategory",
    );
  });
});

describe("classifyBatchWithAi — evidence bundle lives in the user prompt (#814)", () => {
  it("includes receipt evidence and never sends rawHtml", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify(
          fakeMessageResponse({
            classifications: [{ id: 972, categorySlug: "vivienda", confidence: 90 }],
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await classifyBatchWithAi({
      transactions: [
        {
          id: 972,
          description: "MERCADOPAGO COLOMBIA",
          amountCents: BigInt(-85_211_00),
          currency: "COP",
          evidence: [
            {
              receiptId: 10,
              gateway: "mercado_pago",
              merchant: "Almohada Ortopédica Viscoelástica",
              amountCents: "8521100",
              currency: "COP",
              referenceId: "400227",
              extra: { network: "redeban" },
              matchKind: "exact_amount",
              deltaCents: "0",
              deltaMs: 0,
              rank: 1,
            },
          ],
        },
      ],
      categories: CATEGORIES,
      apiKey: "test-key",
      fetchImpl,
    });

    expect(capturedBody).toContain("Almohada Ortopédica Viscoelástica");
    expect(capturedBody).toContain("mercado_pago");
    expect(capturedBody).toContain("exact_amount");
    expect(capturedBody).toContain("classify from the receipt merchant");
    expect(capturedBody).not.toContain("rawHtml");
    expect(capturedBody).not.toContain("<html");
  });
});
