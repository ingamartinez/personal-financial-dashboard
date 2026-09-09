"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { writeTcAccountingEnabled } from "@/lib/flags/tc-accounting";

export async function setTcAccountingEnabled(enabled: unknown): Promise<void> {
  const session = await getSessionUser();
  const parsed = z.boolean().parse(enabled);
  await writeTcAccountingEnabled(session.id, parsed);
  revalidatePath("/", "layout");
}
