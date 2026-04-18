"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { mintInviteCode } from "@/lib/invite-codes";

const mintSchema = z.object({
  maxUses: z.coerce.number().int().min(1).max(50).default(1),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type MintActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; code: string; signupUrl: string };

function buildSignupUrl(code: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/signup?code=${encodeURIComponent(code)}`;
}

export async function mintInviteCodeAction(
  _prev: MintActionState,
  formData: FormData,
): Promise<MintActionState> {
  const session = await getSessionUser();
  const parsed = mintSchema.safeParse({
    maxUses: formData.get("maxUses"),
    expiresInDays: formData.get("expiresInDays") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Invalid input." };
  }
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const row = await mintInviteCode({
    createdByUserId: session.id,
    maxUses: parsed.data.maxUses,
    expiresAt,
  });
  revalidatePath("/settings/invites");
  return { status: "success", code: row.code, signupUrl: buildSignupUrl(row.code) };
}
