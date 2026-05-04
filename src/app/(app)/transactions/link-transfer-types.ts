// #762: Types for link-existing-as-transfer actions.
// Lives in a separate file because "use server" files reject non-async exports —
// Zod schema / type-only exports from actions.ts would 500 every action.
// See engram: nextjs16-server-action-types-split.

import { z } from "zod";

export const linkAsTransferSchema = z.object({
  txIdA: z.coerce.number().int().positive(),
  txIdB: z.coerce.number().int().positive(),
});

export type LinkAsTransferInput = z.input<typeof linkAsTransferSchema>;

export type LinkAsTransferResult = { status: "ok" } | { status: "error"; message: string };

export const findTransferCandidatesSchema = z.object({
  txId: z.coerce.number().int().positive(),
});

export type FindTransferCandidatesInput = z.input<typeof findTransferCandidatesSchema>;

// Compact shape of a candidate transaction shown in the picker.
export type TransferCandidate = {
  id: number;
  occurredAt: string; // ISO timestamp
  amountCents: bigint;
  currency: string;
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  accountId: number;
  accountName: string;
  accountCurrency: string;
  accountInstitution: string | null;
};
