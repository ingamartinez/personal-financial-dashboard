// #621: Types and Zod schemas for link/unlink recurring actions.
// These live in a separate file because "use server" files reject non-async
// exports — a Zod schema export would 500 every action. See nextjs16-server-action-types-split.

import { z } from "zod";

export const linkTxToRecurringSchema = z.object({
  txId: z.coerce.number().int().positive(),
  recurringId: z.coerce.number().int().positive(),
  // If omitted, the action derives it from tx.occurredAt as YYYY-MM.
  yearMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

export type LinkTxToRecurringInput = z.input<typeof linkTxToRecurringSchema>;

export type LinkTxToRecurringResult =
  | { ok: true; yearMonth: string }
  | { ok: false; error: string };

export const unlinkTxFromRecurringSchema = z.object({
  txId: z.coerce.number().int().positive(),
});

export type UnlinkTxFromRecurringInput = z.input<typeof unlinkTxFromRecurringSchema>;

export type UnlinkTxFromRecurringResult = { ok: true } | { ok: false; error: string };

// Compact shape of a recurring passed to the UI picker.
export type RecurringOption = {
  id: number;
  label: string;
  amountCents: bigint;
  currency: string;
  dayOfMonth: number;
  accountId: number;
  accountName: string;
  accountCurrency: string;
};
