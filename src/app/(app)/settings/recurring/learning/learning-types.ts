// #633: Types for recurring learning proposal actions.
// Kept in a separate file because "use server" action files reject non-async exports.

import { z } from "zod";

export const proposalIdSchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  outlierDecision: z.enum(["new_normal", "one_off"]).optional(),
});

export type ProposalActionInput = z.input<typeof proposalIdSchema>;

export type ProposalActionResult = { ok: true } | { ok: false; error: string };
