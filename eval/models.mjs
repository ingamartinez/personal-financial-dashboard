// Model roster + published prices, USD per million tokens.
// Sources (fetched 2026-09-09):
//   Anthropic  — claude-api skill pricing table (cached 2026-06-24) + /v1/models
//   xAI        — https://api.x.ai/v1/language-models (live) cross-checked with docs.x.ai/docs/models
//   DeepSeek   — https://api-docs.deepseek.com/quick_start/pricing (peak rates; off-peak is half)
//   Groq       — https://console.groq.com/docs/models
export const MODELS = [
  // --- Anthropic ---
  {
    key: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5 (production baseline)",
    price: { in: 1.0, out: 5.0, cachedIn: 0.1 },
  },
  {
    key: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    price: { in: 2.0, out: 10.0, cachedIn: 0.2 },
  },
  {
    key: "anthropic/claude-opus-5",
    provider: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5 (quality ceiling ref)",
    price: { in: 5.0, out: 25.0, cachedIn: 0.5 },
    ceiling: true,
  },
  // --- xAI ---
  {
    key: "xai/grok-4.3",
    provider: "xai",
    model: "grok-4.3",
    label: "Grok 4.3 (cheap/fast tier)",
    price: { in: 1.25, out: 2.5, cachedIn: 0.2 },
  },
  {
    key: "xai/grok-4.6",
    provider: "xai",
    model: "grok-4.6",
    label: "Grok 4.6 (flagship)",
    price: { in: 2.0, out: 6.0, cachedIn: 0.5 },
  },
  // --- DeepSeek (peak rates; off-peak 01:00-04:00 & 06:00-10:00 UTC Mon-Fri is half) ---
  {
    key: "deepseek/deepseek-v4-flash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (chat tier)",
    price: { in: 0.44, out: 1.32, cachedIn: 0.014 },
  },
  {
    key: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro (reasoner tier)",
    price: { in: 1.32, out: 3.96, cachedIn: 0.044 },
  },
  // --- Groq (open-weights host) ---
  {
    key: "groq/gpt-oss-120b",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B on Groq",
    price: { in: 0.15, out: 0.6, cachedIn: 0.15 },
  },
];

export const ENDPOINTS = {
  xai: { url: "https://api.x.ai/v1/chat/completions", keyEnv: "GROK_API_KEY" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", keyEnv: "DEEPSEEK_API_KEY" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY" },
};
