"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { insightsReports } from "@/lib/db/schema";
import { buildInsightsSummary, generateInsightsReport, hashSummary } from "@/lib/ai/insights";
import { getCurrentFxRate } from "@/lib/fx/repo";

const ymSchema = z.string().regex(/^\d{4}-\d{2}$/);

export async function generateInsight(ym: string) {
  const parsed = ymSchema.parse(ym);
  const fx = await getCurrentFxRate();
  const summary = await buildInsightsSummary(parsed, fx.rate);
  const inputHash = hashSummary(summary);
  const result = await generateInsightsReport({ summary });

  await db
    .insert(insightsReports)
    .values({
      yearMonth: parsed,
      inputHash,
      markdown: result.markdown,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: insightsReports.yearMonth,
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
  return { ym: parsed, generatedAt: new Date().toISOString() };
}

export async function deleteInsight(ym: string) {
  const parsed = ymSchema.parse(ym);
  await db.delete(insightsReports).where(eq(insightsReports.yearMonth, parsed));
  revalidatePath("/insights");
}
