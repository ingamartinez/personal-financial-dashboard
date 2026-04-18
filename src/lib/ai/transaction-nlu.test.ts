import { describe, expect, it } from "vitest";
import {
  parseTransactionMessage,
  type NluAccountOption,
  type NluCategoryOption,
} from "./transaction-nlu";

function mockFetch(responseJson: unknown): typeof fetch {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return impl;
}

function anthropicResponse(jsonBody: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(jsonBody) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const ACCOUNTS: NluAccountOption[] = [
  { id: 1, name: "Ahorros", institution: "Bancolombia", currency: "COP" },
  { id: 2, name: "Visa", institution: "Bancolombia", currency: "COP", last4s: ["2575"] },
  { id: 3, name: "ARQ", institution: "ARQ", currency: "USD" },
];

const CATEGORIES: NluCategoryOption[] = [
  { slug: "restaurantes", name: "Restaurantes", parentSlug: "alimentacion" },
  { slug: "transporte", name: "Transporte", parentSlug: null },
  { slug: "mercado", name: "Mercado", parentSlug: "alimentacion" },
  { slug: "gasolina", name: "Gasolina", parentSlug: "transporte" },
  { slug: "ingresos", name: "Ingresos", parentSlug: null },
];

const FIXED_NOW = new Date("2026-04-17T18:00:00Z"); // 13:00 Bogota

describe("parseTransactionMessage", () => {
  it('handles "45k" shorthand for expense in a restaurant', async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "4500000",
        currency: "COP",
        direction: "expense",
        merchant: "Restaurante",
        description: "pagué 45k en el restaurante",
        occurredOn: null,
        accountId: null,
        categorySlug: "restaurantes",
        confidence: 85,
      }),
    );

    const result = await parseTransactionMessage({
      text: "pagué 45k en el restaurante",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.amountCents).toBe("4500000");
    expect(result.draft.currency).toBe("COP");
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.categorySlug).toBe("restaurantes");
    expect(result.draft.accountId).toBeNull();
  });

  it('parses "70 mil uber" as transport expense', async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "7000000",
        currency: "COP",
        direction: "expense",
        merchant: "Uber",
        description: "uber",
        occurredOn: null,
        accountId: null,
        categorySlug: "transporte",
        confidence: 90,
      }),
    );

    const result = await parseTransactionMessage({
      text: "70 mil uber",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.amountCents).toBe("7000000");
    expect(result.draft.merchant).toBe("Uber");
    expect(result.draft.categorySlug).toBe("transporte");
  });

  it("parses Colombian thousand separator (123.450)", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "12345000",
        currency: "COP",
        direction: "expense",
        merchant: null,
        description: "mercado",
        occurredOn: null,
        accountId: null,
        categorySlug: "mercado",
        confidence: 80,
      }),
    );

    const result = await parseTransactionMessage({
      text: "mercado 123.450",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.amountCents).toBe("12345000");
    expect(result.draft.categorySlug).toBe("mercado");
  });

  it('resolves "ayer" relative to context.now (Bogota)', async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "3000000",
        currency: "COP",
        direction: "expense",
        merchant: null,
        description: "gasolina",
        occurredOn: "2026-04-16",
        accountId: null,
        categorySlug: "gasolina",
        confidence: 88,
      }),
    );

    const result = await parseTransactionMessage({
      text: "ayer gasté 30k en gasolina",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.occurredOn).toBe("2026-04-16");
    expect(result.draft.direction).toBe("expense");
  });

  it('recognizes income with "ingresé"', async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "200000000",
        currency: "COP",
        direction: "income",
        merchant: null,
        description: "sueldo",
        occurredOn: null,
        accountId: 1,
        categorySlug: "ingresos",
        confidence: 95,
      }),
    );

    const result = await parseTransactionMessage({
      text: "ingresé 2 millones del sueldo",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.direction).toBe("income");
    expect(result.draft.amountCents).toBe("200000000");
    expect(result.draft.accountId).toBe(1);
    expect(result.draft.categorySlug).toBe("ingresos");
  });

  it("resolves account by last4 hint", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "8000000",
        currency: "COP",
        direction: "expense",
        merchant: null,
        description: "mercado",
        occurredOn: null,
        accountId: 2,
        categorySlug: "mercado",
        confidence: 85,
      }),
    );

    const result = await parseTransactionMessage({
      text: "mercado 80k con la *2575",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.accountId).toBe(2);
  });

  it("filters out invalid category slugs", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "5000000",
        currency: "COP",
        direction: "expense",
        merchant: null,
        description: "algo",
        occurredOn: null,
        accountId: null,
        categorySlug: "categoria_inventada",
        confidence: 40,
      }),
    );

    const result = await parseTransactionMessage({
      text: "algo 50k",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.categorySlug).toBeNull();
  });

  it("filters out invalid account ids", async () => {
    const fetchImpl = mockFetch(
      anthropicResponse({
        amountCents: "1000000",
        currency: "COP",
        direction: "expense",
        merchant: null,
        description: "test",
        occurredOn: null,
        accountId: 999,
        categorySlug: null,
        confidence: 50,
      }),
    );

    const result = await parseTransactionMessage({
      text: "10k test",
      context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.draft.accountId).toBeNull();
  });

  it("throws on invalid JSON from model", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "not-json-at-all" }],
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      parseTransactionMessage({
        text: "foo",
        context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("invalid JSON");
  });

  it("throws on API error", async () => {
    const fetchImpl: typeof fetch = async () => new Response("rate limit", { status: 429 });

    await expect(
      parseTransactionMessage({
        text: "foo",
        context: { now: FIXED_NOW, accounts: ACCOUNTS, categories: CATEGORIES },
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("Anthropic API error 429");
  });
});
