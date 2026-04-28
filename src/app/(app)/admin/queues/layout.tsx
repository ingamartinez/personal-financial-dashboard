/**
 * Defense-in-depth auth gate for /admin/queues/*.
 *
 * requireAdmin() is already called in page.tsx and in the Route Handler,
 * but this layout provides an additional enforcement layer so that any
 * future sub-routes added under /admin/queues/ are protected by default.
 */

import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";

export default async function AdminQueuesLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (user.role !== "admin") notFound();

  return <>{children}</>;
}
