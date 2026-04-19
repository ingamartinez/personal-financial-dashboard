"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";

const metadataSchema = z
  .object({
    last4s: z
      .array(z.string().regex(/^\d{4}$/))
      .max(8)
      .optional(),
    network: z.enum(["visa", "mastercard", "amex"]).optional(),
    creditLimitCents: z.number().int().nonnegative().optional(),
    availableCreditCents: z.number().int().nonnegative().optional(),
    cutoffDay: z.number().int().min(1).max(31).optional(),
    paymentDueDay: z.number().int().min(1).max(31).optional(),
    interestRateMonthly: z.number().nonnegative().optional(),
    termMonths: z.number().int().positive().optional(),
    loanOriginalCents: z.number().int().nonnegative().optional(),
    loanRemainingCents: z.number().int().nonnegative().optional(),
    monthlyPaymentCents: z.number().int().nonnegative().optional(),
  })
  .strict();

const sideSchema = z.object({
  currency: z.enum(["COP", "USD"]),
  balance: z.coerce.number().finite(),
  metadata: metadataSchema.optional(),
});

const upsertSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    institution: z.string().min(1).max(50),
    type: z.enum(["savings", "credit_card", "loan"]),
    active: z.coerce.boolean().default(true),
    primary: sideSchema,
    secondary: sideSchema.optional(),
  })
  .refine((v) => !v.secondary || v.type === "credit_card", {
    message: "Multi-currency only supported for credit_card",
    path: ["secondary"],
  })
  .refine((v) => !v.secondary || v.secondary.currency !== v.primary.currency, {
    message: "Secondary currency must differ from primary",
    path: ["secondary", "currency"],
  })
  .refine((v) => !v.secondary || !v.id, {
    message: "Multi-currency can only be set on create",
    path: ["secondary"],
  });

export type AccountUpsertInput = z.input<typeof upsertSchema>;

function revalidate() {
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
}

function sideToValues(side: z.infer<typeof sideSchema>) {
  return {
    currency: side.currency,
    balanceCents: BigInt(Math.round(side.balance * 100)),
    metadata: (side.metadata ?? {}) as AccountMetadata,
  };
}

export async function upsertAccount(input: AccountUpsertInput) {
  const session = await getSessionUser();
  const parsed = upsertSchema.parse(input);

  const base = {
    userId: session.id,
    name: parsed.name,
    institution: parsed.institution,
    type: parsed.type,
    active: parsed.active,
    updatedAt: new Date(),
  };

  if (parsed.id) {
    const primaryValues = sideToValues(parsed.primary);
    await db
      .update(accounts)
      .set({ ...base, ...primaryValues })
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, parsed.id),
          notDeleted(accounts.deletedAt),
        ),
      );
    revalidate();
    return;
  }

  if (parsed.secondary) {
    const physicalCardId = randomUUID();
    await db.transaction(async (trx) => {
      await trx.insert(accounts).values([
        { ...base, ...sideToValues(parsed.primary), physicalCardId },
        { ...base, ...sideToValues(parsed.secondary!), physicalCardId },
      ]);
    });
  } else {
    await db.insert(accounts).values({ ...base, ...sideToValues(parsed.primary) });
  }

  revalidate();
}

export async function archiveAccount(id: number) {
  const session = await getSessionUser();
  const parsedId = z.coerce.number().int().positive().parse(id);
  await db
    .update(accounts)
    .set({ deletedAt: sql`NOW()`, updatedAt: new Date() })
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsedId),
        notDeleted(accounts.deletedAt),
      ),
    );
  revalidate();
}

export async function toggleAccountActive(id: number, active: boolean) {
  const session = await getSessionUser();
  const parsedId = z.coerce.number().int().positive().parse(id);
  await db
    .update(accounts)
    .set({ active, updatedAt: new Date() })
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsedId),
        notDeleted(accounts.deletedAt),
      ),
    );
  revalidate();
}
