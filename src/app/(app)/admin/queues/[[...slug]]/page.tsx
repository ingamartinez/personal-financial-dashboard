/**
 * /admin/queues/[[...slug]] — Bull-Board admin UI gateway.
 *
 * This server component calls requireAdmin() before rendering anything.
 * On success it redirects to the actual Bull-Board Route Handler at
 * /api/admin/queues, which serves the full SPA (HTML + static assets + JSON API).
 *
 * Why redirect instead of inline iframe:
 *   - Bull-Board is a standalone SPA with its own HTML shell, CSS, and JS.
 *   - Embedding it in an iframe would require additional CORS / frame-options work.
 *   - A redirect is simpler and keeps the URL stable for bookmarks.
 *
 * Defense-in-depth: layout.tsx also enforces requireAdmin(), so even if
 * this page is bypassed the layout blocks non-admins.
 */

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/session";

export default async function AdminQueuesPage() {
  await requireAdmin();
  redirect("/api/admin/queues");
}
