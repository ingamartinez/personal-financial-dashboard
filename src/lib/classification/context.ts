// How many merchant hints to keep in users.classification_context.merchant_hints
// (rolling FIFO, newest wins). Larger values give the AI more signal but inflate
// the prompt; buildPrompt in ai.ts further dedupes per merchant before emitting.
export const MERCHANT_HINTS_MAX = 50;
