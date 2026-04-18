import { z } from "zod";

export type NluAccountOption = {
  id: number;
  name: string;
  institution: string;
  currency: "COP" | "USD";
  last4s?: string[];
};

export type NluCategoryOption = {
  slug: string;
  name: string;
  parentSlug?: string | null;
};

export type NluContext = {
  now: Date;
  accounts: NluAccountOption[];
  categories: NluCategoryOption[];
};

export type NluDraft = {
  amountCents: string | null;
  currency: "COP" | "USD" | null;
  direction: "expense" | "income" | null;
  merchant: string | null;
  description: string | null;
  occurredOn: string | null;
  accountId: number | null;
  categorySlug: string | null;
  confidence: number;
  notes?: string;
};

export type NluResult = {
  draft: NluDraft;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// All optional fields use `.nullish()` (accepts null OR undefined) because
// Claude routinely returns explicit `"field": null` for absent values instead
// of omitting the key. Being strict here would crash the parser on perfectly
// valid model output.
const nluResponseSchema = z.object({
  amountCents: z.string().regex(/^\d+$/).nullish(),
  currency: z.enum(["COP", "USD"]).nullish(),
  direction: z.enum(["expense", "income"]).nullish(),
  merchant: z.string().max(200).nullish(),
  description: z.string().max(500).nullish(),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  accountId: z.number().int().nullish(),
  categorySlug: z.string().max(60).nullish(),
  confidence: z.number().int().min(0).max(100),
  notes: z.string().max(200).nullish(),
});

function formatBogotaDate(now: Date): string {
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(bogotaMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildPrompt(text: string, ctx: NluContext): string {
  const today = formatBogotaDate(ctx.now);
  const accList = ctx.accounts
    .map((a) => {
      const last4Part = a.last4s?.length ? ` — termina en ${a.last4s.join(", ")}` : "";
      return `- id=${a.id}: ${a.name} (${a.institution}, ${a.currency})${last4Part}`;
    })
    .join("\n");

  const catList = ctx.categories
    .map((c) => (c.parentSlug ? `- ${c.slug} (sub de ${c.parentSlug})` : `- ${c.slug}`))
    .join("\n");

  return `Sos un parser de transacciones financieras personales para un usuario colombiano. Extraés datos estructurados de mensajes en español informal.

Hoy es ${today} (America/Bogota, UTC-5). Moneda default: COP.

Cuentas disponibles:
${accList}

Categorías disponibles (usá el slug EXACTO):
${catList}

Mensaje del usuario:
"""
${text}
"""

Reglas de parsing:
- "45k", "45 mil", "45K" = 45000. "2 millones", "2M" = 2000000. "450 lucas" = 450000.
- Separador decimal colombiano = coma (45,50 = 45.50). Puntos son separadores de miles: "45.000" = 45000, "1.234.567" = 1234567.
- amountCents: multiplicá el valor monetario por 100 y devolvelo como STRING de dígitos (ej: 45000 pesos → "4500000"; 1.50 USD → "150").
- direction: "expense" por default. "income" sólo si dice "me pagaron", "ingresó", "me llegó", "sueldo", "me transfirieron", "recibí", "cobré".
- occurredOn (YYYY-MM-DD): resolvé "hoy"/"ayer"/"anteayer"/"el viernes"/"hace 3 días" relativo a ${today}. Si no hay señal temporal → null.
- accountId: devolvé un id SOLO si el mensaje identifica la cuenta de forma inequívoca (por nombre, institución o últimos 4 dígitos). Si dice "la visa" y hay 2 visas → null. Si dice "*2575" → buscar por last4.
- categorySlug: devolvé un slug SOLO con señal fuerte (ej: "pagué en el restaurante" → "restaurantes"; "uber" → "transporte_uber_didi" si existe, si no "transporte"). Ante duda → null (el pipeline usará rules+AI después).
- currency: COP por default. USD sólo si dice explícitamente "dólares", "USD", "$USD", o la cuenta elegida es USD.
- merchant: extraelo si aparece. Para "en el Éxito" → "Éxito". Para "pagué 45k" sin lugar → null.
- description: descripción corta en español, max ~80 chars.
- confidence: 0-100. Bajá si falta monto, si la dirección es ambigua, si hay múltiples interpretaciones.
- notes: opcional, ≤200 chars. Usalo si hay algo raro o ambiguo que el usuario debería confirmar.

Devolvé SOLO JSON válido (sin markdown, sin prosa, sin fences):
{
  "amountCents": "<digits-or-null>",
  "currency": "COP" | "USD" | null,
  "direction": "expense" | "income" | null,
  "merchant": "<string-or-null>",
  "description": "<string-or-null>",
  "occurredOn": "YYYY-MM-DD" | null,
  "accountId": <number-or-null>,
  "categorySlug": "<slug-or-null>",
  "confidence": <0-100>,
  "notes": "<optional-string>"
}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function parseTransactionMessage(opts: {
  text: string;
  context: NluContext;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<NluResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const prompt = buildPrompt(opts.text, opts.context);

  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const textBlock = payload.content?.find((c) => c.type === "text")?.text ?? "";
  let parsedJson: unknown;
  try {
    parsedJson = extractJson(textBlock);
  } catch {
    throw new Error("NLU model returned invalid JSON");
  }

  const parsed = nluResponseSchema.parse(parsedJson);

  const validAccountIds = new Set(opts.context.accounts.map((a) => a.id));
  const validCategorySlugs = new Set(opts.context.categories.map((c) => c.slug));
  // Normalize `undefined` to `null` so downstream consumers only handle one
  // "absent" shape. The schema accepts both because models return either.
  const draft: NluDraft = {
    amountCents: parsed.amountCents ?? null,
    currency: parsed.currency ?? null,
    direction: parsed.direction ?? null,
    merchant: parsed.merchant ?? null,
    description: parsed.description ?? null,
    occurredOn: parsed.occurredOn ?? null,
    accountId: parsed.accountId && validAccountIds.has(parsed.accountId) ? parsed.accountId : null,
    categorySlug:
      parsed.categorySlug && validCategorySlugs.has(parsed.categorySlug)
        ? parsed.categorySlug
        : null,
    confidence: parsed.confidence,
    notes: parsed.notes ?? undefined,
  };

  return {
    draft,
    model,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
  };
}
