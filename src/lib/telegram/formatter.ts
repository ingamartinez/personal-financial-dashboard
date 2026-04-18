import type { TelegramBatchItem, TelegramDraft } from "@/lib/db/schema";
import type { NluAccountOption, NluCategoryOption } from "@/lib/ai/transaction-nlu";

function formatAmount(amountCentsStr: string, currency: "COP" | "USD"): string {
  const cents = BigInt(amountCentsStr);
  const HUNDRED = BigInt(100);
  const whole = Number(cents / HUNDRED);
  if (currency === "COP") {
    return `${whole.toLocaleString("es-CO")} COP`;
  }
  const major = Number(cents / HUNDRED);
  const fraction = Number(cents % HUNDRED);
  return `${major.toLocaleString("en-US")}.${String(fraction).padStart(2, "0")} USD`;
}

function directionEmoji(direction: TelegramDraft["direction"]): string {
  if (direction === "income") return "💰 Ingreso";
  if (direction === "expense") return "💸 Gasto";
  return "💱 Movimiento";
}

export function renderConfirmCard(opts: {
  draft: TelegramDraft;
  accounts: NluAccountOption[];
  categories: NluCategoryOption[];
}): string {
  const { draft, accounts, categories } = opts;
  const lines: string[] = [];

  if (draft.amountCents && draft.currency) {
    lines.push(
      `${directionEmoji(draft.direction)} · ${formatAmount(draft.amountCents, draft.currency)}`,
    );
  } else {
    lines.push(directionEmoji(draft.direction));
  }

  if (draft.merchant) {
    lines.push(`🏪 ${draft.merchant}`);
  } else if (draft.description) {
    lines.push(`📝 ${draft.description}`);
  }

  const account = accounts.find((a) => a.id === draft.accountId);
  lines.push(`💳 ${account ? `${account.name} (${account.institution})` : "⚠️ Falta cuenta"}`);

  if (draft.occurredOn) {
    lines.push(`📅 ${draft.occurredOn}`);
  } else {
    lines.push(`📅 Hoy`);
  }

  const category = categories.find((c) => c.slug === draft.categorySlug);
  if (category) lines.push(`🏷️ ${category.name}`);
  else lines.push(`🏷️ (sin categoría — se clasifica después)`);

  if (draft.notes) lines.push(`\n📌 ${draft.notes}`);

  lines.push("");
  lines.push("¿Confirmar?");
  return lines.join("\n");
}

export function renderAskAmount(): string {
  return "¿Cuánto fue? Respondeme con el monto (ej: 45000, 45k, 2 millones).";
}

export function renderAskAccount(): string {
  return "¿De qué cuenta fue?";
}

export function renderAskCategory(): string {
  return "¿Qué categoría?";
}

export function renderUnauthorized(): string {
  return "No autorizado.";
}

export function renderStart(): string {
  return [
    "¡Hola! Soy tu bot de Findash.",
    "",
    "Mandame un mensaje con una transacción y la registro por vos. Por ejemplo:",
    "• `pagué 45k en el restaurante`",
    "• `70 mil uber`",
    "• `ayer gasté 123.450 en el mercado con la visa`",
    "• `ingresé 2 millones del sueldo`",
    "",
    "También podés:",
    "• Reenviarme un SMS de Bancolombia (lo parseo automático).",
    "• Mandarme una foto de un comprobante o lista de transacciones (OCR).",
    "",
    "Comandos:",
    "/help — ayuda",
    "/cancel — descartar el draft actual",
  ].join("\n");
}

export function renderHelp(): string {
  return [
    "Cómo usar el bot:",
    "",
    "1. Mandame un mensaje describiendo una transacción.",
    "2. Te muestro un resumen para que confirmes.",
    "3. Si falta algo (cuenta, monto), te pregunto.",
    "",
    "Atajos:",
    "• `45k` = 45.000 · `2M` = 2.000.000 · `450 lucas` = 450.000",
    "• Decimales con coma: `12,50`",
    "• Fechas: `hoy`, `ayer`, `el viernes`",
    "",
    "/cancel — descartar draft",
  ].join("\n");
}

export function renderCanceled(): string {
  return "Listo, descartado. Mandame otro mensaje cuando quieras.";
}

export function renderInserted(txId: number): string {
  return `✅ Guardada (#${txId}). Mandame otra cuando quieras.`;
}

export function renderError(msg: string): string {
  return `⚠️ ${msg}`;
}

export function renderAskPhotoAccount(): string {
  return "📸 Recibí la foto. ¿A qué cuenta pertenece?";
}

export function renderVoiceProcessing(): string {
  return "🎙️ Escuchando el audio…";
}

export function renderVoiceTooLong(maxSeconds: number): string {
  return `⚠️ El audio es muy largo (>${maxSeconds}s). Mandalo como texto o grabá uno más corto.`;
}

export function renderVoiceTranscription(text: string): string {
  return `🎙️ Escuché: "${text}"`;
}

export function renderOcrProcessing(): string {
  return "⏳ Procesando foto con OCR…";
}

export function renderOcrEmpty(): string {
  return "🤔 No pude extraer ninguna transacción de la foto. Probá con otra imagen más clara.";
}

export function renderBatchSummary(items: TelegramBatchItem[]): string {
  const lines: string[] = [`📋 Encontré ${items.length} transacciones:\n`];
  for (const item of items) {
    const { draft } = item;
    const emoji = draft.direction === "income" ? "💰" : "💸";
    const amount =
      draft.amountCents && draft.currency
        ? formatAmount(draft.amountCents, draft.currency)
        : "(sin monto)";
    const desc = draft.merchant ?? draft.description ?? "(sin descripción)";
    const date = draft.occurredOn ?? "hoy";
    lines.push(`${emoji} ${amount} · ${desc} · ${date}`);
  }
  lines.push("\n¿Confirmar todas?");
  return lines.join("\n");
}

export function renderBatchInserted(opts: {
  inserted: number[];
  duplicated: number;
  errors: number;
}): string {
  const parts: string[] = [];
  if (opts.inserted.length > 0) {
    parts.push(`✅ Guardadas ${opts.inserted.length}`);
  }
  if (opts.duplicated > 0) parts.push(`🔁 ${opts.duplicated} duplicadas`);
  if (opts.errors > 0) parts.push(`⚠️ ${opts.errors} con error`);
  return parts.join(" · ") || "Sin cambios.";
}
