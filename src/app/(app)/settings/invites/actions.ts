"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { mintInviteCode, setInviteDisabled } from "@/lib/invite-codes";
import { buildSignupUrl } from "./signup-url";

const mintSchema = z.object({
  maxUses: z.coerce.number().int().min(1).max(50).default(1),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type MintActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; code: string; signupUrl: string };

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
  const signupUrl = await buildSignupUrl(row.code);
  revalidatePath("/settings/invites");
  return { status: "success", code: row.code, signupUrl };
}

const toggleSchema = z.object({
  code: z.string().min(1).max(64),
  disabled: z.coerce.boolean(),
});

export async function setInviteDisabledAction(formData: FormData): Promise<void> {
  const session = await getSessionUser();
  const parsed = toggleSchema.safeParse({
    code: formData.get("code"),
    disabled: formData.get("disabled"),
  });
  if (!parsed.success) return;
  await setInviteDisabled({
    code: parsed.data.code,
    ownerUserId: session.id,
    disabled: parsed.data.disabled,
  });
  revalidatePath("/settings/invites");
}
