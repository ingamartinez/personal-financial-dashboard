import { createHash } from "node:crypto";
import { aliasedTable, and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  accounts,
  budgets,
  categories,
  recurringTransactions,
  transactions,
  type DisplayCurrencyMode,
} from "@/lib/db/schema";
import { notAdjustment, notDeleted, notInternalMovement } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import type { Currency } from "@/lib/types";
import { callClaudeText } from "@/lib/ai/anthropic-client";
import { createLogger } from "@/lib/logger";
import {
  sumByDisplayCurrency,
  sumByGroupAndDisplayCurrency,
  type AggregationBucket,
} from "@/lib/fx/aggregate";
import { convertCents } from "@/lib/money";

const log = createLogger({ module: "insights-aggregator" });

const DEFAULT_MODEL = "claude-sonnet-4-6";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type InsightsSummary = {
  yearMonth: string;
  previousYearMonth: string;
  generatedFor: string;
  accounts: Array<{
    name: string;
    institution: string;
    type: string;
    currency: Currency;
    balanceCop: number;
  }>;
  totals: {
    incomeCop: number;
    expenseCop: number;
    netCop: number;
    previousIncomeCop: number;
    previousExpenseCop: number;
    previousNetCop: number;
  };
  categoriesCurrent: Array<{ slug: string; name: string; spentCop: number; txCount: number }>;
  categoriesPrevious: Array<{ slug: string; spentCop: number }>;
  topMerchants: Array<{ merchant: string; spentCop: number; txCount: number }>;
  budgets: Array<{
    category: string;
    amountCop: number;
    spentCop: number;
    overBy: number;
  }>;
  recurring: Array<{
    label: string;
    dayOfMonth: number;
    amountCop: number;
    categorySlug: string | null;
  }>;
};

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function calendarBounds(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
    startIso: `${ym}-01`,
  };
}

/**
 * Convert a balance/plan amount (which has no frozen TRM — it's a current
 * value or a forward-looking target) into the user's display currency using
 * LIVE TRM. Used for accounts, budget plans, and recurring plan amounts.
 */
function toDisplayNumber(
  cents: bigint,
  currency: Currency,
  target: Currency,
  liveCopPerUsd: number,
): number {
  if (currency === target) return Number(cents) / 100;
  try {
    return Number(convertCents(cents, currency, target, liveCopPerUsd)) / 100;
  } catch {
    log.warn(
      { fromCurrency: currency, toCurrency: target, event: "insights_balance_conversion_failed" },
      "could not convert balance/plan to display currency — using raw value",
    );
    return Number(cents) / 100;
  }
}

/**
 * Coalesce per-currency aggregation buckets into a single number in `target`
 * currency (pesos or dollars, depending on display mode). Buckets whose
 * currency matches `target` are summed directly. Cross-currency residuals
 * (e.g. rows that lost their frozen TRM in all-X mode) fall back to LIVE TRM.
 */
function coalesceToDisplayNumber(
  buckets: ReadonlyArray<AggregationBucket>,
  target: Currency,
  liveCopPerUsd: number,
): number {
  let totalCents = BigInt(0);
  for (const b of buckets) {
    if (b.currency === target) {
      totalCents += b.cents;
      continue;
    }
    try {
      totalCents += convertCents(b.cents, b.currency as Currency, target, liveCopPerUsd);
    } catch (err) {
      log.warn(
        {
          fromCurrency: b.currency,
          toCurrency: target,
          err: err as Error,
          event: "insights_coalesce_fallback_failed",
        },
        "could not coalesce cross-currency residual bucket — dropping from total",
      );
    }
  }
  return Number(totalCents) / 100;
}

/**
 * Resolve the display currency that the summary fields (incomeCop, etc.) are
 * denominated in. Field names retain the `Cop` suffix for API stability across
 * the AI prompt and the InsightsViewer; the actual unit follows this function.
 */
function resolveDisplayCurrency(mode: DisplayCurrencyMode): Currency {
  return mode === "all-usd" ? "USD" : "COP";
}

/**
 * Build the structured summary that feeds Claude. Spend/income aggregations
 * respect the optional `currentRange` / `previousRange` overrides — pass the
 * resolved `getFinancialPeriod` ranges from the call site so insights match
 * the dashboard's "Flujo del mes". Budget plans stay calendar-anchored
 * (`budgets.periodStart` is calendar) regardless of cycle mode.
 *
 * #526: tx aggregations are now per-row using each tx's frozen TRM
 * (`rawData.fx.trmToAccountCurrency`). Account balances and budget/recurring
 * plans keep using LIVE TRM (`copPerUsd`) since they have no historical rate.
 *
 * Field names keep their `Cop` suffix for API stability across the AI prompt
 * and the InsightsViewer; the actual unit follows the user's
 * `displayCurrencyMode` (COP for `native`/`all-cop`, USD for `all-usd`).
 */
export async function buildInsightsSummary(
  userId: number,
  ym: string,
  copPerUsd: number,
  db: DB = defaultDb,
  ranges?: {
    currentRange?: { start: Date; end: Date };
    previousRange?: { start: Date; end: Date };
  },
  fxOpts?: { displayCurrencyMode: DisplayCurrencyMode },
): Promise<InsightsSummary> {
  const prevYm = shiftMonth(ym, -1);
  const calCur = calendarBounds(ym);
  const calPrev = calendarBounds(prevYm);
  const cur = {
    ...(ranges?.currentRange ?? calCur),
    startIso: calCur.startIso, // budget plan period is always calendar-anchored
  };
  const prev = ranges?.previousRange ?? calPrev;

  const mode: DisplayCurrencyMode = fxOpts?.displayCurrencyMode ?? "native";
  const target = resolveDisplayCurrency(mode);
  const toDisplay = (cents: bigint, currency: Currency) =>
    toDisplayNumber(cents, currency, target, copPerUsd);

  // SQL projection of `raw_data` matches listTransactions (#528) — only
  // `fx` and `merged_statement.fx` cross the boundary.
  const rawDataProjection = sql<Record<string, unknown> | null>`CASE
    WHEN ${transactions.rawData} IS NULL THEN NULL
    ELSE jsonb_build_object(
      'fx', ${transactions.rawData} -> 'fx',
      'merged_statement', jsonb_build_object(
        'fx', ${transactions.rawData} -> 'merged_statement' -> 'fx'
      )
    )
  END`.as("raw_data");

  const [accs, curTxRows, prevTxRows, curCatRows, prevCatRows, merchantRows, budgetRows, recRows] =
    await Promise.all([
      db
        .select({
          name: accounts.name,
          institution: accounts.institution,
          type: accounts.type,
          currency: accounts.currency,
          balanceCents: derivedBalanceCentsSql,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.active, true),
            notDeleted(accounts.deletedAt),
          ),
        )
        .orderBy(asc(accounts.name)),
      // Per-row income/expense for current period — aggregate in JS using helper.
      db
        .select({
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          rawData: rawDataProjection,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, cur.start),
            lt(transactions.occurredAt, cur.end),
            notInternalMovement(transactions.channel),
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        ),
      // Per-row income/expense for previous period.
      db
        .select({
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          rawData: rawDataProjection,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, prev.start),
            lt(transactions.occurredAt, prev.end),
            notInternalMovement(transactions.channel),
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        ),
      (() => {
        const leaf = aliasedTable(categories, "cur_leaf");
        const root = aliasedTable(categories, "cur_root");
        const rootSlug = sql<string | null>`COALESCE(${leaf.parentSlug}, ${leaf.slug})`;
        return db
          .select({
            rootSlug,
            rootName: root.name,
            amountCents: transactions.amountCents,
            currency: transactions.currency,
            rawData: rawDataProjection,
          })
          .from(transactions)
          .leftJoin(
            leaf,
            and(eq(leaf.slug, transactions.categorySlug), eq(leaf.userId, transactions.userId)),
          )
          .leftJoin(root, and(eq(root.slug, rootSlug), eq(root.userId, transactions.userId)))
          .where(
            and(
              eq(transactions.userId, userId),
              gte(transactions.occurredAt, cur.start),
              lt(transactions.occurredAt, cur.end),
              sql`${transactions.amountCents} < 0`,
              notInternalMovement(transactions.channel),
              notAdjustment(transactions.isAdjustment),
              notDeleted(transactions.deletedAt),
            ),
          );
      })(),
      (() => {
        const leaf = aliasedTable(categories, "prev_leaf");
        const rootSlug = sql<string | null>`COALESCE(${leaf.parentSlug}, ${leaf.slug})`;
        return db
          .select({
            rootSlug,
            amountCents: transactions.amountCents,
            currency: transactions.currency,
            rawData: rawDataProjection,
          })
          .from(transactions)
          .leftJoin(
            leaf,
            and(eq(leaf.slug, transactions.categorySlug), eq(leaf.userId, transactions.userId)),
          )
          .where(
            and(
              eq(transactions.userId, userId),
              gte(transactions.occurredAt, prev.start),
              lt(transactions.occurredAt, prev.end),
              sql`${transactions.amountCents} < 0`,
              notInternalMovement(transactions.channel),
              notAdjustment(transactions.isAdjustment),
              notDeleted(transactions.deletedAt),
            ),
          );
      })(),
      // Per-row merchant data — sort + LIMIT 10 happens in JS after conversion
      // (the largest in display currency may differ from largest in native cents).
      db
        .select({
          merchant: transactions.merchant,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          rawData: rawDataProjection,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, cur.start),
            lt(transactions.occurredAt, cur.end),
            sql`${transactions.merchant} IS NOT NULL`,
            sql`${transactions.amountCents} < 0`,
            notInternalMovement(transactions.channel),
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        ),
      db
        .select({
          categorySlug: budgets.categorySlug,
          amountCents: budgets.amountCents,
          currency: budgets.currency,
        })
        .from(budgets)
        .where(
          and(
            eq(budgets.userId, userId),
            eq(budgets.periodStart, cur.startIso),
            notDeleted(budgets.deletedAt),
          ),
        ),
      db
        .select({
          label: recurringTransactions.label,
          dayOfMonth: recurringTransactions.dayOfMonth,
          amountCents: recurringTransactions.amountCents,
          currency: recurringTransactions.currency,
          categorySlug: recurringTransactions.categorySlug,
        })
        .from(recurringTransactions)
        .where(
          and(
            eq(recurringTransactions.userId, userId),
            eq(recurringTransactions.active, true),
            notDeleted(recurringTransactions.deletedAt),
          ),
        )
        .orderBy(asc(recurringTransactions.dayOfMonth)),
    ]);

  // ---------------------------------------------------------------------
  // Totals (income + expense, current + previous)
  // ---------------------------------------------------------------------
  const splitByCharge = (rows: typeof curTxRows) => ({
    income: rows
      .filter((r) => r.amountCents > BigInt(0))
      .map((r) => ({ amountCents: r.amountCents, currency: r.currency, rawData: r.rawData })),
    expense: rows
      .filter((r) => r.amountCents < BigInt(0))
      .map((r) => ({
        amountCents: -r.amountCents,
        currency: r.currency,
        rawData: r.rawData,
      })),
  });

  const curSplit = splitByCharge(curTxRows);
  const prevSplit = splitByCharge(prevTxRows);

  const incomeCop = coalesceToDisplayNumber(
    sumByDisplayCurrency(curSplit.income, mode),
    target,
    copPerUsd,
  );
  const expenseCop = coalesceToDisplayNumber(
    sumByDisplayCurrency(curSplit.expense, mode),
    target,
    copPerUsd,
  );
  const previousIncomeCop = coalesceToDisplayNumber(
    sumByDisplayCurrency(prevSplit.income, mode),
    target,
    copPerUsd,
  );
  const previousExpenseCop = coalesceToDisplayNumber(
    sumByDisplayCurrency(prevSplit.expense, mode),
    target,
    copPerUsd,
  );

  // ---------------------------------------------------------------------
  // Categories — current + previous
  // ---------------------------------------------------------------------
  const positiveCurCatRows = curCatRows.map((r) => ({
    rootSlug: r.rootSlug,
    rootName: r.rootName,
    amountCents: -r.amountCents, // expense → positive
    currency: r.currency,
    rawData: r.rawData,
  }));
  const groupedCurCats = sumByGroupAndDisplayCurrency(positiveCurCatRows, mode, (r) => r.rootSlug);

  // Track root names so the AI prompt has friendly labels.
  const rootNameBySlug = new Map<string, string>();
  for (const r of positiveCurCatRows) {
    if (r.rootSlug && r.rootName) rootNameBySlug.set(r.rootSlug, r.rootName);
  }

  const categoriesCurrent: Array<{
    slug: string;
    name: string;
    spentCop: number;
    txCount: number;
  }> = [];
  for (const [slug, buckets] of groupedCurCats) {
    const spentCop = coalesceToDisplayNumber(buckets, target, copPerUsd);
    const txCount = buckets.reduce((acc, b) => acc + b.txCount, 0);
    categoriesCurrent.push({
      slug,
      name: rootNameBySlug.get(slug) ?? slug,
      spentCop,
      txCount,
    });
  }
  categoriesCurrent.sort((a, b) => b.spentCop - a.spentCop);

  const positivePrevCatRows = prevCatRows.map((r) => ({
    rootSlug: r.rootSlug,
    amountCents: -r.amountCents,
    currency: r.currency,
    rawData: r.rawData,
  }));
  const groupedPrevCats = sumByGroupAndDisplayCurrency(
    positivePrevCatRows,
    mode,
    (r) => r.rootSlug,
  );
  const categoriesPrevious: Array<{ slug: string; spentCop: number }> = [];
  for (const [slug, buckets] of groupedPrevCats) {
    categoriesPrevious.push({
      slug,
      spentCop: coalesceToDisplayNumber(buckets, target, copPerUsd),
    });
  }

  // ---------------------------------------------------------------------
  // Top merchants — convert per-row, then sort and slice 10.
  // ---------------------------------------------------------------------
  const positiveMerchantRows = merchantRows
    .filter((r): r is typeof r & { merchant: string } => r.merchant !== null)
    .map((r) => ({
      merchant: r.merchant,
      amountCents: -r.amountCents,
      currency: r.currency,
      rawData: r.rawData,
    }));
  const groupedMerchants = sumByGroupAndDisplayCurrency(
    positiveMerchantRows,
    mode,
    (r) => r.merchant,
  );
  const topMerchants: Array<{ merchant: string; spentCop: number; txCount: number }> = [];
  for (const [merchant, buckets] of groupedMerchants) {
    const spentCop = coalesceToDisplayNumber(buckets, target, copPerUsd);
    const txCount = buckets.reduce((acc, b) => acc + b.txCount, 0);
    topMerchants.push({ merchant, spentCop, txCount });
  }
  topMerchants.sort((a, b) => b.spentCop - a.spentCop);
  topMerchants.splice(10);

  // ---------------------------------------------------------------------
  // Budget plans — amount via LIVE TRM (no historical rate exists), spent
  // pulled from the per-category aggregation above.
  // ---------------------------------------------------------------------
  const categorySpentMap = new Map(categoriesCurrent.map((c) => [c.slug, c.spentCop]));
  const budgetsOut = budgetRows.map((b) => {
    const amountCop = toDisplay(b.amountCents, b.currency);
    const spentCop = categorySpentMap.get(b.categorySlug) ?? 0;
    return {
      category: b.categorySlug,
      amountCop,
      spentCop,
      overBy: Math.max(0, spentCop - amountCop),
    };
  });

  const recurringOut = recRows.map((r) => ({
    label: r.label,
    dayOfMonth: r.dayOfMonth,
    amountCop: toDisplay(r.amountCents, r.currency),
    categorySlug: r.categorySlug,
  }));

  const accountsOut = accs.map((a) => ({
    name: a.name,
    institution: a.institution,
    type: a.type,
    currency: a.currency,
    balanceCop: toDisplay(BigInt(a.balanceCents), a.currency),
  }));

  // Reduce to scalar totals to keep the existing public shape unchanged
  // (the legacy contract expected `incomeCop` and friends as plain numbers).
  const totals = { incomeCop, expenseCop, previousIncomeCop, previousExpenseCop };

  return {
    yearMonth: ym,
    previousYearMonth: prevYm,
    generatedFor: ym,
    accounts: accountsOut,
    totals: {
      incomeCop: Math.round(totals.incomeCop),
      expenseCop: Math.round(totals.expenseCop),
      netCop: Math.round(totals.incomeCop - totals.expenseCop),
      previousIncomeCop: Math.round(totals.previousIncomeCop),
      previousExpenseCop: Math.round(totals.previousExpenseCop),
      previousNetCop: Math.round(totals.previousIncomeCop - totals.previousExpenseCop),
    },
    categoriesCurrent: categoriesCurrent.map((c) => ({ ...c, spentCop: Math.round(c.spentCop) })),
    categoriesPrevious: categoriesPrevious.map((c) => ({ ...c, spentCop: Math.round(c.spentCop) })),
    topMerchants: topMerchants.map((m) => ({ ...m, spentCop: Math.round(m.spentCop) })),
    budgets: budgetsOut.map((b) => ({
      ...b,
      amountCop: Math.round(b.amountCop),
      spentCop: Math.round(b.spentCop),
      overBy: Math.round(b.overBy),
    })),
    recurring: recurringOut.map((r) => ({ ...r, amountCop: Math.round(r.amountCop) })),
  };
}

export function hashSummary(summary: InsightsSummary): string {
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}

// Stable across all users and months — task framing, output structure, and
// the formatting rules. Gets cache_control so Sonnet 4.6 can amortize it
// across requests (cache threshold is 2048 tokens; this + the stable
// investment advisory block combine to comfortably exceed that).
const INSIGHTS_SYSTEM_PROMPT = `Sos un asesor financiero personal para un usuario colombiano. Analizás sus finanzas mensuales y das recomendaciones PRÁCTICAS y LOCALES.

Generá un reporte en MARKDOWN con estas secciones (usá headings H2):

## Resumen del mes
2-3 oraciones: cómo le fue vs el mes anterior (ingresos, gastos, ahorro). Destacá si mejoró o empeoró.

## Categorías que se dispararon
Categorías donde el gasto creció >20% vs mes anterior, o que se comieron un porcentaje grande del ingreso. Sé específico con montos.

## Presupuestos
Si hay presupuestos: cuáles se pasaron, cuáles están cerca del límite. Si no hay, sugerí 2-3 categorías críticas para presupuestar.

## Oportunidades de ahorro
2-4 recomendaciones concretas. Apuntá a:
- Merchants repetidos con gasto alto (consolidación, cancelación de suscripciones)
- Categorías donde claramente hay fuga (delivery excesivo, entretenimiento)
- Gastos recurrentes que podrían renegociarse

## Qué hacer con el excedente
Si el neto del mes es positivo, sugerí opciones colombianas concretas:
- **CDTs**: bancos con tasas competitivas (Bancolombia, Davivienda, Scotiabank Colpatria — NO inventes tasas específicas, decí "consultá tasas actuales")
- **FICs** (Fondos de Inversión Colectiva): mencionar tipos (renta fija corto plazo, acciones) según tolerancia al riesgo
- **Fondos indexados globales** vía brokers colombianos (Trii, Tyba) para diversificación USD
- **Pago anticipado de deudas** si hay cuentas tipo credit_card o loan con saldo
Si el neto es negativo o cero, acá reemplazá esta sección por "## Cómo recuperar el mes" con pasos concretos.

## Acciones de esta semana
Lista de 3-5 bullets accionables, específicos, que el usuario pueda hacer en los próximos 7 días.

Reglas:
- Hablá en español rioplatense neutro, directo, sin moralizar.
- NO inventes números que no están en los datos.
- NO sugieras productos de bancos específicos con tasas inventadas.
- Sé breve: cada sección 3-6 líneas máximo.
- Usá montos formateados con separador de miles (ej: $1.250.000).
- Si no hay datos para una sección, decilo brevemente y seguí.

Devolvé SOLO el markdown del reporte, sin prefacio.`;

function buildUserPrompt(summary: InsightsSummary): string {
  return `Datos del mes ${summary.yearMonth} (montos en COP, valor absoluto):

${JSON.stringify(summary, null, 2)}`;
}

export async function generateInsightsReport(opts: {
  summary: InsightsSummary;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  markdown: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const result = await callClaudeText({
    system: [{ text: INSIGHTS_SYSTEM_PROMPT, cacheControl: true }],
    userPrompt: buildUserPrompt(opts.summary),
    model: opts.model ?? DEFAULT_MODEL,
    maxTokens: 3000,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  return {
    markdown: result.text,
    model: result.model,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}

export function isStale(generatedAt: Date, storedHash: string, currentHash: string): boolean {
  if (storedHash !== currentHash) return true;
  return Date.now() - generatedAt.getTime() > CACHE_TTL_MS;
}
