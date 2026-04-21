import { z } from "zod";

// Schemas live in a sibling file because Next.js 16 "use server" modules can
// only export async functions — exporting a Zod schema from actions.ts would
// 500 every action.
export const mintWidgetTokenSchema = z.object({
  label: z.string().trim().max(120).optional(),
});

export const revokeWidgetTokenSchema = z.object({
  tokenId: z.coerce.number().int().positive(),
});
