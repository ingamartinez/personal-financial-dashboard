// #809: unit tests for the proposedCategory sanitization in classifyBatchWithAi.
// Uses a fake fetch (same pattern as anthropic-client.test.ts) so no network
// call is made and no API key is required.

import { describe, expect, it } from "vitest";
import { classifyBatchWithAi } from "./ai";

function fakeMessageResponse(payload: unknown): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
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
