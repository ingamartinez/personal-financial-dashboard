import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/receipts/raw" });

// Next.js 16: params must be awaited
type Params = Promise<{ id: string }>;

/**
 * GET /api/integrations/gmail/receipts/[id]/raw
 *
 * Returns the raw HTML of an email receipt for authenticated owners.
 * Tenant-checks the receipt before serving — returns 404 for cross-tenant
 * access (intentionally indistinguishable from "not found").
 *
 * Security:
 * - Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
 *   img-src 'self' data:  — blocks JS execution, external resource loads,
 *   forms, navigation, and popups.
 * - X-Frame-Options: SAMEORIGIN — if embedded in an iframe, only same origin
 *   can frame it.
 * - In-app view (v1): this route is opened in a new tab via "Ver email original"
 *   link. An in-dialog iframe was deliberately skipped to avoid CSS fighting.
 */
export async function GET(_request: Request, { params }: { params: Params }) {
  const user = await getSessionUserOrNull();
  if (!user) {
    return new Response("Unauthenticated", { status: 401 });
  }

  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response("Not found", { status: 404 });
  }

  const [row] = await db
    .select({ id: emailReceipts.id, rawHtml: emailReceipts.rawHtml, userId: emailReceipts.userId })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.id, id),
        eq(emailReceipts.userId, user.id),
        notDeleted(emailReceipts.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    log.warn(
      { userId: user.id, receiptId: id, event: "raw_email_not_found" },
      "raw email receipt not found or cross-tenant attempt",
    );
    return new Response("Not found", { status: 404 });
  }

  return new Response(row.rawHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Tight CSP: no external JS, no external resources, no forms, no nav.
      // unsafe-inline for style only (email formatting uses inline styles).
      // img-src 'self' data: allows base64-embedded images (common in receipts).
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      // No cache — HTML may contain PII
      "Cache-Control": "no-store",
    },
  });
}
