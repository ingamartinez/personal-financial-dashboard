"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { setUserActive, setUserRole, type UpdateResult } from "@/lib/users/queries";

export type UserActionResult = { status: "ok" } | { status: "error"; message: string };

const toggleSchema = z.object({
  userId: z.coerce.number().int().positive(),
  active: z.coerce.boolean(),
});

export async function setUserActiveAction(formData: FormData): Promise<UserActionResult> {
  await requireAdmin();
  const parsed = toggleSchema.safeParse({
    userId: formData.get("userId"),
    active: formData.get("active"),
  });
  if (!parsed.success) return { status: "error", message: "Datos inválidos." };
  const outcome: UpdateResult = await setUserActive(parsed.data);
  if (outcome === "last-admin") {
    return { status: "error", message: "No se puede desactivar al último admin activo." };
  }
  revalidatePath("/settings/users");
  return { status: "ok" };
}

const roleSchema = z.object({
  userId: z.coerce.number().int().positive(),
  role: z.enum(["admin", "user"]),
});

export async function setUserRoleAction(formData: FormData): Promise<UserActionResult> {
  await requireAdmin();
  const parsed = roleSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { status: "error", message: "Datos inválidos." };
  const outcome: UpdateResult = await setUserRole(parsed.data);
  if (outcome === "last-admin") {
    return { status: "error", message: "No se puede demotar al último admin activo." };
  }
  revalidatePath("/settings/users");
  return { status: "ok" };
}
