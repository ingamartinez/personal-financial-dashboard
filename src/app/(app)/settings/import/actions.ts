"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, ingestionLogs, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { classifyByRule } from "@/lib/classification/rules";
import { parseBancolombiaXlsx, type ParsedRow } from "@/lib/ingestion/xlsx-bancolombia";
import {
  extractTransactionsFromImage,
  type OcrMediaType,
  type OcrParsedRow,
} from "@/lib/ingestion/ocr";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";

const previewSchema = z.object({
  accountId: z.coerce.number().int().positive(),
});

export type PreviewRow = ParsedRow & { duplicate: boolean };

export type PreviewResult = {
  accountId: number;
  rows: PreviewRow[];
  skipped: { rowIndex: number; reason: string }[];
  totals: { parsed: number; duplicates: number; new: number };
};

export async function previewBancolombiaXlsx(formData: FormData): Promise<PreviewResult> {
  const session = await getSessionUser();
  const { accountId } = previewSchema.parse({ accountId: formData.get("accountId") });
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file uploaded");
  if (file.size === 0) throw new Error("File is empty");
  if (file.size > 5 * 1024 * 1024) throw new Error("File too large (>5MB)");

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("Account not found");

  const buf = Buffer.from(await file.arrayBuffer());
  const { rows, skipped } = parseBancolombiaXlsx(buf, accountId);

  const externalIds = rows.map((r) => r.externalId);
  const existing = externalIds.length
    ? await db
        .select({ externalId: transactions.externalId })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, session.id),
            eq(transactions.accountId, accountId),
            inArray(transactions.externalId, externalIds),
          ),
        )
    : [];
  const existingSet = new Set(existing.map((e) => e.externalId));

  const previewRows: PreviewRow[] = rows.map((r) => ({
    ...r,
    duplicate: existingSet.has(r.externalId),
  }));

  return {
    accountId,
    rows: previewRows,
    skipped,
    totals: {
      parsed: rows.length,
      duplicates: previewRows.filter((r) => r.duplicate).length,
      new: previewRows.filter((r) => !r.duplicate).length,
    },
  };
}

const confirmSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  rows: z.array(
    z.object({
      occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().min(1).max(500),
      reference: z.string().nullable(),
      amountCents: z.string().regex(/^-?\d+$/),
      externalId: z.string().min(1).max(200),
    }),
  ),
});

export type ConfirmInput = z.infer<typeof confirmSchema>;
export type ConfirmResult = {
  inserted: number;
  duplicated: number;
};

export async function confirmBancolombiaImport(input: ConfirmInput): Promise<ConfirmResult> {
  const session = await getSessionUser();
  const parsed = confirmSchema.parse(input);
  const startedAt = new Date();

  const [account] = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsed.accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("Account not found");

  let inserted = 0;
  let duplicated = 0;
  const errors: string[] = [];

  for (const r of parsed.rows) {
    try {
      const cls = await classifyByRule(session.id, { descriptionRaw: r.description });
      const result = await db
        .insert(transactions)
        .values({
          userId: session.id,
          accountId: account.id,
          occurredAt: new Date(`${r.occurredOn}T12:00:00Z`),
          amountCents: BigInt(r.amountCents),
          currency: account.currency,
          descriptionRaw: r.description,
          descriptionClean: null,
          merchant: null,
          categorySlug: cls?.categorySlug ?? null,
          classificationMethod: cls ? "rule" : "unclassified",
          classificationConfidence: cls?.confidence ?? null,
          source: "csv",
          externalId: r.externalId,
        })
        .onConflictDoNothing({
          target: [transactions.accountId, transactions.externalId],
          where: sql`${transactions.externalId} IS NOT NULL`,
        })
        .returning({ id: transactions.id });

      if (result.length > 0) {
        inserted++;
        await autoLinkTransaction(session.id, result[0].id);
      } else duplicated++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await db.insert(ingestionLogs).values({
    userId: session.id,
    source: "csv",
    status: errors.length === 0 ? "ok" : "partial",
    itemsReceived: parsed.rows.length,
    itemsInserted: inserted,
    itemsDuplicated: duplicated,
    errorMessage: errors.length ? errors.slice(0, 5).join("; ") : null,
    payload: { accountId: parsed.accountId, format: "xlsx-bancolombia" },
    startedAt,
    finishedAt: new Date(),
  });

  revalidatePath("/");
  revalidatePath("/transactions");

  return { inserted, duplicated };
}

const ocrPreviewSchema = z.object({
  accountId: z.coerce.number().int().positive(),
});

const ALLOWED_MEDIA: OcrMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type OcrPreviewRow = OcrParsedRow & { duplicate: boolean };

export type OcrPreviewResult = {
  accountId: number;
  rows: OcrPreviewRow[];
  skipped: { rowIndex: number; reason: string }[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  totals: { parsed: number; duplicates: number; new: number };
};

export async function previewScreenshotOcr(formData: FormData): Promise<OcrPreviewResult> {
  const session = await getSessionUser();
  const { accountId } = ocrPreviewSchema.parse({
    accountId: formData.get("accountId"),
  });
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No image uploaded");
  if (file.size === 0) throw new Error("Image is empty");
  if (file.size > 8 * 1024 * 1024) throw new Error("Image too large (>8MB)");
  if (!ALLOWED_MEDIA.includes(file.type as OcrMediaType)) {
    throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  }

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("Account not found");

  const buf = Buffer.from(await file.arrayBuffer());
  const imageBase64 = buf.toString("base64");

  const result = await extractTransactionsFromImage({
    imageBase64,
    mediaType: file.type as OcrMediaType,
    accountId,
  });

  const externalIds = result.rows.map((r) => r.externalId);
  const existing = externalIds.length
    ? await db
        .select({ externalId: transactions.externalId })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, session.id),
            eq(transactions.accountId, accountId),
            inArray(transactions.externalId, externalIds),
          ),
        )
    : [];
  const existingSet = new Set(existing.map((e) => e.externalId));

  const rows: OcrPreviewRow[] = result.rows.map((r) => ({
    ...r,
    duplicate: existingSet.has(r.externalId),
  }));

  return {
    accountId,
    rows,
    skipped: result.skipped,
    model: result.model,
    usage: result.usage,
    totals: {
      parsed: rows.length,
      duplicates: rows.filter((r) => r.duplicate).length,
      new: rows.filter((r) => !r.duplicate).length,
    },
  };
}

const confirmOcrSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  rows: z.array(
    z.object({
      occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().min(1).max(500),
      amountCents: z.string().regex(/^-?\d+$/),
      externalId: z.string().min(1).max(200),
    }),
  ),
});

export type ConfirmOcrInput = z.infer<typeof confirmOcrSchema>;

export async function confirmOcrImport(input: ConfirmOcrInput): Promise<ConfirmResult> {
  const session = await getSessionUser();
  const parsed = confirmOcrSchema.parse(input);
  const startedAt = new Date();

  const [account] = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsed.accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("Account not found");

  let inserted = 0;
  let duplicated = 0;
  const errors: string[] = [];

  for (const r of parsed.rows) {
    try {
      const cls = await classifyByRule(session.id, { descriptionRaw: r.description });
      const result = await db
        .insert(transactions)
        .values({
          userId: session.id,
          accountId: account.id,
          occurredAt: new Date(`${r.occurredOn}T12:00:00Z`),
          amountCents: BigInt(r.amountCents),
          currency: account.currency,
          descriptionRaw: r.description,
          descriptionClean: null,
          merchant: null,
          categorySlug: cls?.categorySlug ?? null,
          classificationMethod: cls ? "rule" : "unclassified",
          classificationConfidence: cls?.confidence ?? null,
          source: "ocr",
          externalId: r.externalId,
        })
        .onConflictDoNothing({
          target: [transactions.accountId, transactions.externalId],
          where: sql`${transactions.externalId} IS NOT NULL`,
        })
        .returning({ id: transactions.id });

      if (result.length > 0) {
        inserted++;
        await autoLinkTransaction(session.id, result[0].id);
      } else duplicated++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await db.insert(ingestionLogs).values({
    userId: session.id,
    source: "ocr",
    status: errors.length === 0 ? "ok" : "partial",
    itemsReceived: parsed.rows.length,
    itemsInserted: inserted,
    itemsDuplicated: duplicated,
    errorMessage: errors.length ? errors.slice(0, 5).join("; ") : null,
    payload: { accountId: parsed.accountId, format: "screenshot-ocr" },
    startedAt,
    finishedAt: new Date(),
  });

  revalidatePath("/");
  revalidatePath("/transactions");

  return { inserted, duplicated };
}
