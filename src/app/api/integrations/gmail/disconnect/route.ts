import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { newOAuth2ClientForFlow } from "@/lib/gmail/client";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/disconnect" });

export async function POST() {
  const user = await getSessionUserOrNull();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const [row] = await db
    .select({
      id: gmailConnections.id,
      refreshTokenEnc: gmailConnections.refreshTokenEnc,
    })
    .from(gmailConnections)
    .where(and(eq(gmailConnections.userId, user.id), notDeleted(gmailConnections.deletedAt)))
    .limit(1);

  if (!row) {
    // Idempotent — disconnecting a nonexistent connection is a success.
    return NextResponse.json({ ok: true });
  }

  // Best-effort revoke at Google. We soft-delete the row regardless of
  // whether the revoke call succeeds, so a transient network blip can't
  // strand a user with a "still connected" pill they can't clear.
  try {
    const refreshToken = gmailCipher.decrypt(row.refreshTokenEnc);
    const oauth = newOAuth2ClientForFlow();
    await oauth.revokeToken(refreshToken);
  } catch (err) {
    log.warn(
      { err, userId: user.id, connectionId: row.id, event: "gmail_revoke_best_effort_failed" },
      "Google revokeToken failed — proceeding with local soft-delete",
    );
  }

  await db
    .update(gmailConnections)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(gmailConnections.id, row.id));

  log.info(
    { userId: user.id, connectionId: row.id, event: "gmail_disconnected" },
    "Gmail connection disconnected",
  );
  return NextResponse.json({ ok: true });
}
