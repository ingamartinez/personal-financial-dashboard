"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import {
  WEBHOOK_PURPOSES,
  mintWebhookToken,
  revokeWebhookToken,
  type WebhookPurpose,
} from "@/lib/webhook-tokens";

const mintSchema = z.object({
  purpose: z.enum(WEBHOOK_PURPOSES as unknown as [WebhookPurpose, ...WebhookPurpose[]]),
  label: z.string().trim().max(120).optional(),
});

export type MintActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; id: number; purpose: WebhookPurpose; plaintext: string };

export async function mintWebhookTokenAction(
  _prev: MintActionState,
  formData: FormData,
): Promise<MintActionState> {
  const session = await getSessionUser();
  const parsed = mintSchema.safeParse({
    purpose: formData.get("purpose"),
    label: formData.get("label") ?? undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Invalid input." };
  }
  const { id, plaintext } = await mintWebhookToken({
    userId: session.id,
    purpose: parsed.data.purpose,
    label: parsed.data.label ?? null,
  });
  revalidatePath("/settings/webhooks");
  return { status: "success", id, purpose: parsed.data.purpose, plaintext };
}

const revokeSchema = z.object({
  tokenId: z.coerce.number().int().positive(),
});

export async function revokeWebhookTokenAction(input: z.input<typeof revokeSchema>) {
  const session = await getSessionUser();
  const { tokenId } = revokeSchema.parse(input);
  const ok = await revokeWebhookToken({ userId: session.id, tokenId });
  if (!ok) {
    throw new Error("Token not found, already revoked, or not yours.");
  }
  revalidatePath("/settings/webhooks");
}
