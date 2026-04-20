import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "ai/anthropic-client" });

// Haiku 4.5 is the cost-effective default for Findash's two primary AI
// workloads today: transaction classification and SMS parse fallback. Per
// AI Strategy (see engram memory): Haiku for hot-path-ish and bulk work,
// Sonnet reserved for conversational / multi-step reasoning.
// Callsites needing a different model must pass `model` explicitly.
export const DEFAULT_MODEL = "claude-haiku-4-5";

// Parse/classify responses are tiny structured JSON blobs — not long prose.
// Keep the default small to bound latency; callers override when they need
// room (batch classification with many items).
export const DEFAULT_MAX_TOKENS = 1024;

export type SystemPromptBlock = {
  text: string;
  // When true, adds cache_control: { type: "ephemeral" } to this block. Use
  // for stable content (category list, few-shots, task instructions). Cache
  // only takes effect once the prefix exceeds the model minimum (Haiku 4.5:
  // 4096 tokens); shorter prefixes silently won't cache but the marker is
  // harmless. See shared/prompt-caching.md.
  cacheControl?: boolean;
};

export type CallClaudeOpts<T> = {
  // Stable, cacheable content — instructions, categories, few-shots.
  // String for simple cases; array of blocks when you want selective caching.
  system?: string | SystemPromptBlock[];
  // Volatile per-request content — the transaction list, the SMS body.
  userPrompt: string;
  // Zod schema for the model's JSON response. Enforced server-side via
  // output_config.format — rejects hallucinations before they reach us.
  schema: ZodType<T>;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  // Per-request timeout. Pipelines with hard budgets (SMS AI fallback: 2s)
  // must set this explicitly.
  timeoutMs?: number;
  // Test seam — the SDK passes this through as its HTTP transport.
  fetchImpl?: typeof fetch;
};

export type CallClaudeResult<T> = {
  data: T;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
};

export async function callClaude<T>(opts: CallClaudeOpts<T>): Promise<CallClaudeResult<T>> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const clientOpts: { apiKey: string; fetch?: typeof fetch; timeout?: number } = { apiKey };
  if (opts.fetchImpl) clientOpts.fetch = opts.fetchImpl;
  if (opts.timeoutMs !== undefined) clientOpts.timeout = opts.timeoutMs;
  const client = new Anthropic(clientOpts);

  const systemBlocks = buildSystemBlocks(opts.system);

  try {
    const response = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      ...(systemBlocks && { system: systemBlocks }),
      messages: [{ role: "user", content: opts.userPrompt }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });

    if (response.parsed_output == null) {
      throw new Error(
        `Claude response did not parse against schema (stop_reason=${response.stop_reason})`,
      );
    }

    return {
      data: response.parsed_output,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      log.warn({ err, model, event: "ai_rate_limited" }, "anthropic rate limited");
    } else if (err instanceof Anthropic.APIError) {
      log.error({ err, model, status: err.status, event: "ai_api_error" }, "anthropic api error");
    }
    throw err;
  }
}

function buildSystemBlocks(
  system: CallClaudeOpts<unknown>["system"],
): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;
  if (typeof system === "string") {
    return [{ type: "text", text: system }];
  }
  return system.map<Anthropic.TextBlockParam>((block) =>
    block.cacheControl
      ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: block.text },
  );
}
