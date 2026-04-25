import type { TelegramBatchItem, TelegramDraft } from "@/lib/db/schema";
import type { NluAccountOption, NluCategoryOption } from "@/lib/ai/transaction-nlu";
import type { PullResult } from "@/lib/gmail/pull";
import type { BackfillDryRunReport, BackfillReport } from "@/lib/gmail/backfill";
import type { GatewayId } from "@/lib/gmail/registry";
import { formatAccountLabel } from "@/lib/accounts/format";

// ---------------------------------------------------------------------------
// Disambiguation prompts (#456)
// ---------------------------------------------------------------------------

export type DisambiguationCandidate = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  descriptionRaw: string;
  /** Pre-formatted account label via formatAccountLabel (institution · name *last4 (currency)). */
  accountLabel: string;
};

export function renderDisambiguationPrompt(opts: {
  receiptId: number;
  receiptMerchant: string | null | undefined;
  receiptOccurredAt: Date | null | undefined;
  candidates: DisambiguationCandidate[];
}): string {
  const { receiptId, receiptMerchant, receiptOccurredAt, candidates } = opts;

  const merchantLabel = receiptMerchant ?? "desconocido";
  const dateLabel = receiptOccurredAt
    ? receiptOccurredAt.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "?";

  const lines: string[] = [
    `🔍 Recibo ambiguo #${receiptId}: *${merchantLabel}* (${dateLabel})`,
    "",
    "Estas transacciones podrían corresponder a ese recibo. Elegí una:",
    "",
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const amount = formatCandidateAmount(c.amountCents, c.currency);
    const date = c.occurredAt.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "2-digit",
    });
    const desc = truncate(c.descriptionRaw, 40);
    lines.push(`*${i + 1}.*  ${amount} · ${desc}  [${date}]`);
    lines.push(`      ${c.accountLabel}`);
  }

  lines.push("");
  lines.push("Respondé con el número (1, 2, …) o /omitir para descartar este recibo.");
  return lines.join("\n");
}

export function renderDisambiguationConfirmed(txId: number): string {
  return `✅ Recibo vinculado a la transacción #${txId}. ¡Gracias!`;
}

export function renderDisambiguationRejected(): string {
  return "🗑️ Recibo descartado.";
}

export function renderRevisarEmpty(): string {
  return "✅ No tenés transacciones ambiguas pendientes.";
}

export function renderRevisarPending(receiptId: number): string {
  return `Ya tenés una consulta de desambiguación abierta (recibo #${receiptId}). Respondela primero o usá /cancel para descartarla.`;
}

export function renderOmitirNada(): string {
  return "Nada para omitir. No hay una consulta de desambiguación abierta.";
}

export function renderDisambiguationReprompt(): string {
  return "No entendí. Respondé con el número (1, 2, …) o /omitir para descartar este recibo.";
}

export function renderDisambiguationError(): string {
  return "⚠️ Algo falló procesando tu respuesta. Probá de nuevo.";
}

export function renderReauthNudge(appUrl: string): string {
  return [
    "🔌 Tu conexión Gmail expiró (Google testing mode renueva cada 7 días).",
    "",
    `Reconectá: ${appUrl}/settings/integrations`,
  ].join("\n");
}

function formatCandidateAmount(amountCents: bigint, currency: "COP" | "USD"): string {
  const HUNDRED = BigInt(100);
  if (currency === "COP") {
    const whole = Number(amountCents / HUNDRED);
    return `${whole.toLocaleString("es-CO")} COP`;
  }
  const major = Number(amountCents / HUNDRED);
  const frac = Number(amountCents % HUNDRED);
  return `${major.toLocaleString("en-US")}.${String(frac).padStart(2, "0")} USD`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

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
  lines.push(
    `💳 ${account ? formatAccountLabel(account, { withInstitution: true, withLast4: true }) : "⚠️ Falta cuenta"}`,
  );

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

export function renderNoAccounts(): string {
  return [
    "⚠️ Todavía no tenés cuentas cargadas.",
    "",
    "Entrá a Findash en la web, andá a *Settings → Accounts* y creá al menos una antes de registrar movimientos.",
  ].join("\n");
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

const GATEWAY_LABELS: Record<GatewayId, string> = {
  mercado_pago: "Mercado Pago",
  payu: "PayU",
  wompi: "Wompi",
  apple: "Apple",
  paypal: "PayPal",
  bancolombia: "Bancolombia",
};

export function renderEnrichProcessing(): string {
  return "📧 Buscando emails nuevos en tu Gmail…";
}

export function renderEnrichResult(result: PullResult): string {
  const breakdown = (Object.entries(result.byGateway) as [GatewayId, { pulled: number }][])
    .filter(([, v]) => v.pulled > 0)
    .map(([id, v]) => `${v.pulled} ${GATEWAY_LABELS[id]}`)
    .join(", ");

  const lines: string[] = [];
  if (result.pulled === 0 && result.skipped === 0) {
    lines.push("📭 No encontré emails nuevos.");
  } else {
    const tail = breakdown ? ` (${breakdown})` : "";
    lines.push(`📧 Ingresé ${result.pulled} recibos nuevos${tail}.`);
    if (result.skipped > 0) lines.push(`🔁 Omití ${result.skipped} ya vistos.`);
  }
  if (result.errors.length > 0) {
    lines.push(`⚠️ ${result.errors.length} errores — revisá los logs.`);
  }
  return lines.join("\n");
}

export function renderEnrichConnectPrompt(): string {
  return [
    "📧 Todavía no tenés una cuenta de Gmail conectada.",
    "",
    "Entrá a *Settings → Integrations* en la web para conectarla.",
  ].join("\n");
}

export function renderEnrichFailed(): string {
  return "⚠️ Algo falló buscando emails. Probá de nuevo en un rato.";
}

export function renderBackfillConfirmPrompt(opts: {
  year: number;
  preview: BackfillDryRunReport;
}): string {
  const { year, preview } = opts;
  const lines = [
    `📧 Backfill Bancolombia *${year}*`,
    "",
    `• Emails encontrados: ${preview.totalEmails}`,
    `• Ya ingresados: ${preview.alreadyStored}`,
    `• Nuevos a procesar: ${preview.newEmails}`,
  ];
  if (preview.newEmails === 0) {
    lines.push("", "✅ No hay nada nuevo que ingresar. Listo.");
    return lines.join("\n");
  }
  lines.push("", "Confirmá con /si para arrancar, o /cancel para abortar.");
  return lines.join("\n");
}

export function renderBackfillStarting(): string {
  return "📧 Arrancando backfill… te mando progreso cada 100 emails.";
}

export function renderBackfillProgress(opts: { processed: number; total: number }): string {
  return `📧 Backfill: ${opts.processed}/${opts.total} procesados…`;
}

export function renderBackfillResult(report: BackfillReport): string {
  const lines: string[] = [];
  if (report.canceled) {
    lines.push("🛑 Backfill cancelado.");
  } else {
    lines.push("✅ Backfill completo.");
  }
  lines.push(
    `• Emails revisados: ${report.totalEmails} (ya vistos: ${report.alreadyStored})`,
    `• Parseados: ${report.parsed} · omitidos: ${report.skipped} · no reconocidos: ${report.needsReview}`,
    `• Transacciones nuevas: ${report.inserted}`,
    `• Ya existían (dedup A+): ${report.matchedExisting}`,
  );
  if (report.sourceMismatches > 0) {
    lines.push(`⚠️ Divergencias con otra fuente: ${report.sourceMismatches} — revisá en la web.`);
  }
  if (report.errors.length > 0) {
    lines.push(`⚠️ ${report.errors.length} errores — revisá los logs.`);
  }
  const seconds = Math.round(report.durationMs / 100) / 10;
  lines.push(`⏱️ ${seconds}s`);
  return lines.join("\n");
}

export function renderBackfillConnectPrompt(
  reason: "not_connected" | "revoked" | "unusable",
): string {
  if (reason === "not_connected") {
    return [
      "📧 Todavía no tenés una cuenta de Gmail conectada.",
      "",
      "Entrá a *Settings → Integrations* en la web para conectarla.",
    ].join("\n");
  }
  return [
    "📧 Tu conexión de Gmail dejó de funcionar (token revocado o expirado).",
    "",
    "Entrá a *Settings → Integrations* en la web para reconectarla.",
  ].join("\n");
}

export function renderBackfillFailed(): string {
  return "⚠️ Algo falló con el backfill. Probá de nuevo en un rato.";
}

export function renderBackfillNothingPending(): string {
  return "Nada pendiente que confirmar. Escribí /backfill-gmail para arrancar uno.";
}
