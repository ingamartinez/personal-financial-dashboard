"use server";

import { revalidatePath } from "next/cache";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { mintWebhookToken, revokeWebhookToken } from "@/lib/webhook-tokens";
import { mintWidgetTokenSchema, revokeWidgetTokenSchema } from "./schemas";

export type MintWidgetActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; id: number; plaintext: string };

export async function mintWidgetTokenAction(
  _prev: MintWidgetActionState,
  formData: FormData,
): Promise<MintWidgetActionState> {
  const session = await getSessionUserOrNull();
  if (!session) {
    return { status: "error", message: "No autenticado." };
  }
  const parsed = mintWidgetTokenSchema.safeParse({
    label: formData.get("label") ?? undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Entrada inválida." };
  }
  const { id, plaintext } = await mintWebhookToken({
    userId: session.id,
    purpose: "widget",
    label: parsed.data.label ?? null,
  });
  revalidatePath("/settings/widgets");
  return { status: "success", id, plaintext };
}

export async function revokeWidgetTokenAction(input: { tokenId: number }): Promise<void> {
  const session = await getSessionUserOrNull();
  if (!session) {
    throw new Error("No autenticado.");
  }
  const { tokenId } = revokeWidgetTokenSchema.parse(input);
  const ok = await revokeWebhookToken({ userId: session.id, tokenId });
  if (!ok) {
    throw new Error("Token no encontrado, ya revocado, o no te pertenece.");
  }
  revalidatePath("/settings/widgets");
}
