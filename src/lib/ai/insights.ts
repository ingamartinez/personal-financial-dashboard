import { createHash } from "node:crypto";
import { aliasedTable, and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  accounts,
  budgets,
  categories,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import type { Currency } from "@/lib/types";
import { callClaudeText } from "@/lib/ai/anthropic-client";

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

function toCopNumber(cents: bigint, currency: Currency, copPerUsd: number): number {
  const pesos = Number(cents) / 100;
  return currency === "USD" ? pesos * copPerUsd : pesos;
}

/**
 * Build the structured summary that feeds Claude. Spend/income aggregations
 * respect the optional `currentRange` / `previousRange` overrides — pass the
 * resolved `getFinancialPeriod` ranges from the call site so insights match
 * the dashboard's "Flujo del mes". Budget plans stay calendar-anchored
 * (`budgets.periodStart` is calendar) regardless of cycle mode.
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
): Promise<InsightsSummary> {
  const prevYm = shiftMonth(ym, -1);
  const calCur = calendarBounds(ym);
  const calPrev = calendarBounds(prevYm);
  const cur = {
    ...(ranges?.currentRange ?? calCur),
    startIso: calCur.startIso, // budget plan period is always calendar-anchored
  };
  const prev = ranges?.previousRange ?? calPrev;

  const [accs, curTxTotals, prevTxTotals, curCats, prevCats, topMer, budgetRows, recRows] =
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
      db
        .select({
          currency: transactions.currency,
          income: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
          expense: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, cur.start),
            lt(transactions.occurredAt, cur.end),
            sql`${transactions.channel} <> 'transfer'`,
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        )
        .groupBy(transactions.currency),
      db
        .select({
          currency: transactions.currency,
          income: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
          expense: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, prev.start),
            lt(transactions.occurredAt, prev.end),
            sql`${transactions.channel} <> 'transfer'`,
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        )
        .groupBy(transactions.currency),
      (() => {
        const leaf = aliasedTable(categories, "cur_leaf");
        const root = aliasedTable(categories, "cur_root");
        const rootSlug = sql<string | null>`COALESCE(${leaf.parentSlug}, ${leaf.slug})`;
        return db
          .select({
            slug: rootSlug,
            name: root.name,
            currency: transactions.currency,
            spent: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
            txCount: sql<number>`COUNT(*)::int`,
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
              sql`${transactions.channel} <> 'transfer'`,
              notAdjustment(transactions.isAdjustment),
              notDeleted(transactions.deletedAt),
            ),
          )
          .groupBy(rootSlug, root.name, transactions.currency);
      })(),
      (() => {
        const leaf = aliasedTable(categories, "prev_leaf");
        const rootSlug = sql<string | null>`COALESCE(${leaf.parentSlug}, ${leaf.slug})`;
        return db
          .select({
            slug: rootSlug,
            currency: transactions.currency,
            spent: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
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
              sql`${transactions.channel} <> 'transfer'`,
              notAdjustment(transactions.isAdjustment),
              notDeleted(transactions.deletedAt),
            ),
          )
          .groupBy(rootSlug, transactions.currency);
      })(),
      db
        .select({
          merchant: transactions.merchant,
          currency: transactions.currency,
          spent: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
          txCount: sql<number>`COUNT(*)::int`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, cur.start),
            lt(transactions.occurredAt, cur.end),
            sql`${transactions.merchant} IS NOT NULL`,
            sql`${transactions.amountCents} < 0`,
            sql`${transactions.channel} <> 'transfer'`,
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        )
        .groupBy(transactions.merchant, transactions.currency)
        .orderBy(
          desc(
            sql`SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END)`,
          ),
        )
        .limit(10),
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

  const totals = { incomeCop: 0, expenseCop: 0, previousIncomeCop: 0, previousExpenseCop: 0 };
  for (const r of curTxTotals) {
    totals.incomeCop += toCopNumber(BigInt(r.income), r.currency, copPerUsd);
    totals.expenseCop += toCopNumber(BigInt(r.expense), r.currency, copPerUsd);
  }
  for (const r of prevTxTotals) {
    totals.previousIncomeCop += toCopNumber(BigInt(r.income), r.currency, copPerUsd);
    totals.previousExpenseCop += toCopNumber(BigInt(r.expense), r.currency, copPerUsd);
  }

  const catMap = new Map<
    string,
    { slug: string; name: string; spentCop: number; txCount: number }
  >();
  for (const r of curCats) {
    if (!r.slug) continue;
    const key = r.slug;
    const cop = toCopNumber(BigInt(r.spent), r.currency, copPerUsd);
    const existing = catMap.get(key);
    if (existing) {
      existing.spentCop += cop;
      existing.txCount += r.txCount;
    } else {
      catMap.set(key, { slug: r.slug, name: r.name ?? r.slug, spentCop: cop, txCount: r.txCount });
    }
  }
  const categoriesCurrent = [...catMap.values()].sort((a, b) => b.spentCop - a.spentCop);

  const prevCatMap = new Map<string, number>();
  for (const r of prevCats) {
    if (!r.slug) continue;
    prevCatMap.set(
      r.slug,
      (prevCatMap.get(r.slug) ?? 0) + toCopNumber(BigInt(r.spent), r.currency, copPerUsd),
    );
  }
  const categoriesPrevious = [...prevCatMap.entries()].map(([slug, spentCop]) => ({
    slug,
    spentCop,
  }));

  const merMap = new Map<string, { merchant: string; spentCop: number; txCount: number }>();
  for (const r of topMer) {
    if (!r.merchant) continue;
    const cop = toCopNumber(BigInt(r.spent), r.currency, copPerUsd);
    const existing = merMap.get(r.merchant);
    if (existing) {
      existing.spentCop += cop;
      existing.txCount += r.txCount;
    } else {
      merMap.set(r.merchant, { merchant: r.merchant, spentCop: cop, txCount: r.txCount });
    }
  }
  const topMerchants = [...merMap.values()].sort((a, b) => b.spentCop - a.spentCop).slice(0, 10);

  const budgetsOut = budgetRows.map((b) => {
    const amountCop = toCopNumber(b.amountCents, b.currency, copPerUsd);
    const spentCop = catMap.get(b.categorySlug)?.spentCop ?? 0;
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
    amountCop: toCopNumber(r.amountCents, r.currency, copPerUsd),
    categorySlug: r.categorySlug,
  }));

  const accountsOut = accs.map((a) => ({
    name: a.name,
    institution: a.institution,
    type: a.type,
    currency: a.currency,
    balanceCop: toCopNumber(BigInt(a.balanceCents), a.currency, copPerUsd),
  }));

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
