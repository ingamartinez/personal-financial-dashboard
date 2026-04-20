"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { DISPLAY_CURRENCY_MODES } from "@/lib/db/schema";
import { updateUiPreferences } from "./repo";

export async function setDisplayCurrencyMode(mode: unknown): Promise<void> {
  const session = await getSessionUser();
  const parsed = z.enum(DISPLAY_CURRENCY_MODES).parse(mode);
  await updateUiPreferences(session.id, { displayCurrencyMode: parsed });
  revalidatePath("/", "layout");
}
