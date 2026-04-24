"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import { resetUserData } from "@/lib/reset/reset";

const log = createLogger({ module: "reset.actions" });

// The UI gates the real button behind a typed-confirmation input. We also
// validate server-side — a client bypassing the dialog must still send the
// exact literal, so forged requests fail loudly.
const CONFIRM_LITERAL = "RESET";

const schema = z.object({
  confirm: z.literal(CONFIRM_LITERAL),
});

export type ResetActionResult =
  | {
      status: "ok";
      snapshot: { id: number; name: string; payloadBytes: string };
    }
  | { status: "error"; message: string };

export async function resetUserDataAction(
  input: z.input<typeof schema>,
): Promise<ResetActionResult> {
  const session = await getSessionUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Confirmation text did not match." };
  }

  try {
    const { snapshot } = await resetUserData({ userId: session.id });

    // Bust caches for every page that reads transactional data.
    revalidatePath("/");
    revalidatePath("/transactions");
    revalidatePath("/budgets");
    revalidatePath("/insights");
    revalidatePath("/settings/snapshots");
    revalidatePath("/settings/reset");

    return {
      status: "ok",
      snapshot: {
        id: snapshot.id,
        name: snapshot.name,
        payloadBytes: snapshot.payloadBytes.toString(),
      },
    };
  } catch (err) {
    log.error({ err, userId: session.id, event: "reset_failed" }, "reset failed");
    return { status: "error", message: "Reset failed — no data was changed." };
  }
}
