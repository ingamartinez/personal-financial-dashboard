"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { insightsReports } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { buildInsightsSummary, generateInsightsReport, hashSummary } from "@/lib/ai/insights";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getFinancialPeriod } from "@/lib/dashboard/period";
import { getUiPreferences } from "@/lib/preferences/repo";
import { createLogger } from "@/lib/logger";
import { emitNotification } from "@/lib/notifications/emit";

const log = createLogger({ module: "insights.actions" });

const ymSchema = z.string().regex(/^\d{4}-\d{2}$/);

export async function generateInsight(ym: string) {
  const session = await getSessionUser();
  const parsed = ymSchema.parse(ym);
  const fx = await getCurrentFxRate();
  // Resolve current + previous periods so the AI input matches the
  // dashboard / page view exactly. Previous month uses the same cycle mode.
  const [y, m] = parsed.split("-").map(Number);
  const [currentPeriod, previousPeriod, prefs] = await Promise.all([
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 1, 15))),
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 2, 15))),
    getUiPreferences(session.id),
  ]);
  const summary = await buildInsightsSummary(
    session.id,
    parsed,
    fx.rate,
    undefined,
    {
      currentRange: { start: currentPeriod.start, end: currentPeriod.end },
      previousRange: { start: previousPeriod.start, end: previousPeriod.end },
    },
    { displayCurrencyMode: prefs.displayCurrencyMode },
  );
  const inputHash = hashSummary(summary);
  const result = await generateInsightsReport({ summary });

  await db
    .insert(insightsReports)
    .values({
      userId: session.id,
      yearMonth: parsed,
      inputHash,
      markdown: result.markdown,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [insightsReports.userId, insightsReports.yearMonth],
      set: {
        inputHash,
        markdown: result.markdown,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        generatedAt: new Date(),
      },
    });

  revalidatePath("/insights");

  await emitNotification(session.id, {
    type: "insights_report_ready",
    entityId: String(parsed),
    priority: "low",
    title: "Reporte de insights listo",
    body: `Tu análisis de ${parsed} está listo para revisar.`,
    actionUrl: `/insights?yearMonth=${parsed}`,
    metadata: { yearMonth: parsed },
  }).catch((emitErr: unknown) => {
    log.error(
      {
        err: emitErr,
        userId: session.id,
        yearMonth: parsed,
        event: "emit_insights_report_ready_failed",
      },
      "failed to emit insights_report_ready notification",
    );
  });

  return { ym: parsed, generatedAt: new Date().toISOString() };
}

export async function deleteInsight(ym: string) {
  const session = await getSessionUser();
  const parsed = ymSchema.parse(ym);
  await db
    .delete(insightsReports)
    .where(and(eq(insightsReports.userId, session.id), eq(insightsReports.yearMonth, parsed)));
  revalidatePath("/insights");
}
