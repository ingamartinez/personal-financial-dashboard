import type { TelegramDraft } from "@/lib/db/schema";
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
