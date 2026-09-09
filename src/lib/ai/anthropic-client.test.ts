import { describe, it, expect } from "vitest";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import {
  callClaude,
  callClaudeText,
  cacheMinimumTokens,
  inspectCacheablePrefix,
  DEFAULT_MODEL,
  HAIKU_MODEL,
} from "./anthropic-client";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

function mockFetch(
  responseBody: unknown,
  captured: CapturedRequest[],
  init?: { status?: number; errorBody?: unknown },
): typeof fetch {
  return (async (input: Request | URL | string, reqInit?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = reqInit?.body ? JSON.parse(String(reqInit.body)) : {};
    captured.push({ url, body });
    const status = init?.status ?? 200;
    const resBody = status === 200 ? responseBody : (init?.errorBody ?? { error: "oops" });
    return new Response(JSON.stringify(resBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function fakeMessageResponse(payload: unknown): Record<string, unknown> {
  // Minimal shape of a v1/messages response — just enough for the SDK's
  // parser to extract `parsed_output` when output_config.format is set.
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

describe("model ids", () => {
  it("defaults classification-class models to undated Sonnet 5", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(HAIKU_MODEL).toBe("claude-haiku-4-5");
  });
});

describe("cacheMinimumTokens", () => {
  it("uses 4096 for Haiku 4.5 and 1024 for Sonnet 5", () => {
    expect(cacheMinimumTokens("claude-haiku-4-5")).toBe(4096);
    expect(cacheMinimumTokens("claude-sonnet-5")).toBe(1024);
    expect(cacheMinimumTokens("unknown-model")).toBe(4096);
  });
});

describe("inspectCacheablePrefix", () => {
  it("does not warn when cache_control is absent", () => {
    expect(inspectCacheablePrefix("claude-haiku-4-5", "plain")).toMatchObject({
      cacheRequested: false,
      belowMin: false,
    });
    expect(inspectCacheablePrefix("claude-haiku-4-5", [{ text: "no marker" }])).toMatchObject({
      cacheRequested: false,
      belowMin: false,
    });
  });

  it("warns when the estimated prefix is below the active model minimum", () => {
    const short = "x".repeat(100);
    const inspection = inspectCacheablePrefix("claude-haiku-4-5", [
      { text: short, cacheControl: true },
    ]);
    expect(inspection.cacheRequested).toBe(true);
    expect(inspection.belowMin).toBe(true);
    expect(inspection.minTokens).toBe(4096);
    expect(inspection.estimatedTokens).toBe(Math.ceil(short.length / 4));
  });

  it("does not warn when the estimated prefix meets Sonnet 5's 1024 minimum", () => {
    const longEnough = "x".repeat(4096); // 1024 tokens at chars/4
    const inspection = inspectCacheablePrefix("claude-sonnet-5", [
      { text: longEnough, cacheControl: true },
    ]);
    expect(inspection.belowMin).toBe(false);
    expect(inspection.estimatedTokens).toBe(1024);
  });

  it("counts system blocks up to the last cache breakpoint as the prefix", () => {
    const inspection = inspectCacheablePrefix("claude-sonnet-5", [
      { text: "a".repeat(2000) },
      { text: "b".repeat(2000), cacheControl: true },
      { text: "volatile-not-in-prefix" },
    ]);
    expect(inspection.estimatedTokens).toBe(1000);
    expect(inspection.belowMin).toBe(true);
  });
});

describe("callClaude", () => {
  const Schema = z.object({
    label: z.string(),
    confidence: z.number(),
  });

  it("sends cache_control on system blocks that request it", async () => {
    const captured: CapturedRequest[] = [];
    await callClaude({
      feature: "classification",
      system: [
        { text: "STABLE: category list", cacheControl: true },
        { text: "VOLATILE: this-run context" },
      ],
      userPrompt: "classify this",
      schema: Schema,
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse({ label: "food", confidence: 0.9 }), captured),
    });

    expect(captured).toHaveLength(1);
    const system = captured[0].body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].cache_control).toBeUndefined();
    expect(captured[0].body.model).toBe("claude-sonnet-5");
  });

  it("does not attach tools — shared by classification, OCR, NLU and insights", async () => {
    const captured: CapturedRequest[] = [];
    await callClaude({
      feature: "classification",
      userPrompt: "classify this",
      schema: Schema,
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse({ label: "food", confidence: 0.9 }), captured),
    });
    expect(captured[0].body.tools).toBeUndefined();
  });

  it("accepts a bare string system prompt with no cache breakpoint", async () => {
    const captured: CapturedRequest[] = [];
    await callClaude({
      feature: "classification",
      system: "plain system",
      userPrompt: "hi",
      schema: Schema,
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse({ label: "x", confidence: 0 }), captured),
    });

    const system = captured[0].body.system as Array<Record<string, unknown>>;
    expect(system[0]).toEqual({ type: "text", text: "plain system" });
    expect(system[0].cache_control).toBeUndefined();
  });

  it("returns typed parsed_output and usage stats", async () => {
    const payload = { label: "transporte", confidence: 0.85 };
    const result = await callClaude({
      feature: "nlu",
      userPrompt: "classify",
      schema: Schema,
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse(payload), []),
    });

    expect(result.data).toEqual(payload);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(10);
  });

  it("sends image blocks ahead of the user text when images are provided", async () => {
    const captured: CapturedRequest[] = [];
    await callClaude({
      feature: "ocr",
      userPrompt: "extract",
      images: [{ mediaType: "image/png", data: "ZmFrZQ==" }],
      schema: Schema,
      model: HAIKU_MODEL,
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse({ label: "x", confidence: 0 }), captured),
    });

    expect(captured[0].body.model).toBe("claude-haiku-4-5");
    const messages = captured[0].body.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" },
      },
      { type: "text", text: "extract" },
    ]);
  });

  it("rethrows typed Anthropic.APIError on non-2xx responses", async () => {
    await expect(
      callClaude({
        feature: "classification",
        userPrompt: "x",
        schema: Schema,
        apiKey: "sk-test",
        fetchImpl: mockFetch({}, [], {
          status: 500,
          errorBody: { type: "error", error: { type: "api_error", message: "boom" } },
        }),
      }),
    ).rejects.toBeInstanceOf(Anthropic.APIError);
  });

  it("rethrows typed RateLimitError on 429", async () => {
    await expect(
      callClaude({
        feature: "classification",
        userPrompt: "x",
        schema: Schema,
        apiKey: "sk-test",
        fetchImpl: mockFetch({}, [], {
          status: 429,
          errorBody: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        }),
      }),
    ).rejects.toBeInstanceOf(Anthropic.RateLimitError);
  });

  it("throws when ANTHROPIC_API_KEY is not set and no apiKey is passed", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        callClaude({
          feature: "classification",
          userPrompt: "x",
          schema: Schema,
          fetchImpl: mockFetch(fakeMessageResponse({ label: "x", confidence: 0 }), []),
        }),
      ).rejects.toThrow("ANTHROPIC_API_KEY is not set");
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

// ---------------------------------------------------------------------------
// callClaudeText — prose path (no schema, returns raw text)
// ---------------------------------------------------------------------------

function fakeTextResponse(
  text: string,
  usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 800,
      output_tokens: 250,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 640,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

describe("callClaudeText", () => {
  it("returns the concatenated text + cache usage", async () => {
    const result = await callClaudeText({
      feature: "insights",
      system: [{ text: "You are a financial advisor.", cacheControl: true }],
      userPrompt: "summarize this",
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeTextResponse("## Report\n\nAll good."), []),
    });

    expect(result.text).toBe("## Report\n\nAll good.");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.usage.inputTokens).toBe(800);
    expect(result.usage.cacheReadTokens).toBe(640);
  });

  it("distinguishes a cache hit from a cache miss in usage", async () => {
    const hit = await callClaudeText({
      feature: "insights",
      userPrompt: "ok",
      apiKey: "sk-test",
      fetchImpl: mockFetch(
        fakeTextResponse("reply", { cache_read_input_tokens: 640, cache_creation_input_tokens: 0 }),
        [],
      ),
    });
    const miss = await callClaudeText({
      feature: "insights",
      userPrompt: "ok",
      apiKey: "sk-test",
      fetchImpl: mockFetch(
        fakeTextResponse("reply", { cache_read_input_tokens: 0, cache_creation_input_tokens: 800 }),
        [],
      ),
    });

    expect(hit.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(miss.usage.cacheReadTokens).toBe(0);
    expect(miss.usage.cacheCreationTokens).toBeGreaterThan(0);
  });

  it("sends cache_control on the marked system block", async () => {
    const captured: CapturedRequest[] = [];
    await callClaudeText({
      feature: "insights",
      system: [{ text: "stable rules", cacheControl: true }, { text: "volatile context" }],
      userPrompt: "ok",
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeTextResponse("reply"), captured),
    });
    const system = captured[0].body.system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].cache_control).toBeUndefined();
  });

  it("throws when the response has no text blocks", async () => {
    await expect(
      callClaudeText({
        feature: "insights",
        userPrompt: "x",
        apiKey: "sk-test",
        fetchImpl: mockFetch(fakeTextResponse(""), []),
      }),
    ).rejects.toThrow(/empty text/i);
  });

  it("rethrows typed Anthropic.APIError on non-2xx", async () => {
    await expect(
      callClaudeText({
        feature: "insights",
        userPrompt: "x",
        apiKey: "sk-test",
        fetchImpl: mockFetch({}, [], {
          status: 500,
          errorBody: { type: "error", error: { type: "api_error", message: "boom" } },
        }),
      }),
    ).rejects.toBeInstanceOf(Anthropic.APIError);
  });
});
