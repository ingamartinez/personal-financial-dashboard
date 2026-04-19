"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { categories } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { categoryExists, countCategoryReferences } from "@/lib/categories/queries";

const slugSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug: minúsculas, números y guiones.");

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color debe ser hex (#rrggbb).");

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(80),
  parentSlug: slugSchema.nullable(),
  icon: z.string().max(40).nullable(),
  color: hexColorSchema.nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(500),
});

const updateSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(80),
  parentSlug: slugSchema.nullable(),
  icon: z.string().max(40).nullable(),
  color: hexColorSchema.nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
});

const archiveSchema = z.object({ slug: slugSchema });

export type CategoryActionResult = { status: "ok" } | { status: "error"; message: string };

export async function createCategory(
  input: z.input<typeof createSchema>,
): Promise<CategoryActionResult> {
  const session = await getSessionUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  if (await categoryExists(session.id, parsed.data.slug)) {
    return { status: "error", message: "Ya tenés una categoría con ese slug." };
  }

  if (parsed.data.parentSlug) {
    const parentExists = await categoryExists(session.id, parsed.data.parentSlug);
    if (!parentExists) {
      return { status: "error", message: "La categoría padre no existe o está archivada." };
    }
    if (parsed.data.parentSlug === parsed.data.slug) {
      return { status: "error", message: "Una categoría no puede ser su propio padre." };
    }
  }

  await db.insert(categories).values({
    userId: session.id,
    slug: parsed.data.slug,
    name: parsed.data.name,
    parentSlug: parsed.data.parentSlug,
    icon: parsed.data.icon,
    color: parsed.data.color,
    sortOrder: parsed.data.sortOrder,
  });

  revalidatePath("/settings/categories");
  return { status: "ok" };
}

export async function updateCategory(
  input: z.input<typeof updateSchema>,
): Promise<CategoryActionResult> {
  const session = await getSessionUser();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  if (!(await categoryExists(session.id, parsed.data.slug))) {
    return { status: "error", message: "Categoría no encontrada." };
  }

  if (parsed.data.parentSlug) {
    if (parsed.data.parentSlug === parsed.data.slug) {
      return { status: "error", message: "Una categoría no puede ser su propio padre." };
    }
    const parentExists = await categoryExists(session.id, parsed.data.parentSlug);
    if (!parentExists) {
      return { status: "error", message: "La categoría padre no existe o está archivada." };
    }
  }

  await db
    .update(categories)
    .set({
      name: parsed.data.name,
      parentSlug: parsed.data.parentSlug,
      icon: parsed.data.icon,
      color: parsed.data.color,
      sortOrder: parsed.data.sortOrder,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(categories.userId, session.id),
        eq(categories.slug, parsed.data.slug),
        notDeleted(categories.deletedAt),
      ),
    );

  revalidatePath("/settings/categories");
  return { status: "ok" };
}

export type ArchiveResult =
  | { status: "ok" }
  | { status: "blocked"; reason: string }
  | { status: "error"; message: string };

export async function archiveCategory(
  input: z.input<typeof archiveSchema>,
): Promise<ArchiveResult> {
  const session = await getSessionUser();
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Slug inválido." };
  }

  if (!(await categoryExists(session.id, parsed.data.slug))) {
    return { status: "error", message: "Categoría no encontrada." };
  }

  // Guardrail: block archive if the category is referenced. Soft-archiving a
  // parent that still has live children would orphan them in the UI. Same for
  // transactions/budgets/rules — we keep referential integrity by refusing
  // to archive instead of silently repointing references.
  const usage = await countCategoryReferences(session.id, parsed.data.slug);
  const blockers: string[] = [];
  if (usage.children > 0) blockers.push(`${usage.children} subcategorías`);
  if (usage.transactions > 0) blockers.push(`${usage.transactions} transacciones`);
  if (usage.budgets > 0) blockers.push(`${usage.budgets} presupuestos`);
  if (usage.classificationRules > 0) blockers.push(`${usage.classificationRules} reglas`);
  if (usage.counterparties > 0) blockers.push(`${usage.counterparties} contrapartes`);
  if (usage.recurringTransactions > 0) {
    blockers.push(`${usage.recurringTransactions} recurrentes`);
  }

  if (blockers.length > 0) {
    return {
      status: "blocked",
      reason: `No se puede archivar: está en uso por ${blockers.join(", ")}.`,
    };
  }

  await db
    .update(categories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(categories.userId, session.id), eq(categories.slug, parsed.data.slug)));

  revalidatePath("/settings/categories");
  return { status: "ok" };
}
