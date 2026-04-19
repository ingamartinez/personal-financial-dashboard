import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inviteCodes, users } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "bootstrap-invites" });

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/I/1 ambiguity
const CODE_LENGTH = 12;

function mintCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return code;
}

async function resolveBootstrapUser(): Promise<{ id: number; email: string }> {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim();
  if (!email) {
    throw new Error("BOOTSTRAP_USER_EMAIL is not set");
  }
  const name = process.env.BOOTSTRAP_USER_NAME?.trim() || email;
  await db.insert(users).values({ email, name }).onConflictDoNothing({ target: users.email });
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!row) {
    throw new Error(`Failed to ensure bootstrap user for ${email}`);
  }
  return row;
}

export async function bootstrapInvites(count = 5): Promise<string[]> {
  const bootstrap = await resolveBootstrapUser();
  log.info(
    { email: bootstrap.email, userId: bootstrap.id, event: "bootstrap_invites_user" },
    "bootstrap user resolved",
  );

  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = mintCode();
    await db.insert(inviteCodes).values({ code, createdByUserId: bootstrap.id, maxUses: 1 });
    codes.push(code);
  }
  return codes;
}

if (import.meta.main) {
  const count = Number(process.env.INVITE_COUNT ?? 5);
  bootstrapInvites(count)
    .then((codes) => {
      log.info({ count: codes.length, event: "bootstrap_invites_minted" }, "minted invite codes");
      for (const code of codes) {
        log.info({ code, event: "bootstrap_invites_code" }, "invite code");
      }
      log.info(
        { event: "bootstrap_invites_done" },
        "share each code via a trusted channel — they are single-use.",
      );
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err, event: "bootstrap_invites_failed" }, "bootstrap-invites failed");
      process.exit(1);
    });
}
