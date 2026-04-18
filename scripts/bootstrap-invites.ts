import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inviteCodes, users } from "@/lib/db/schema";

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/I/1 ambiguity
const CODE_LENGTH = 12;

function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
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
  console.log(`bootstrap user: ${bootstrap.email} (id=${bootstrap.id})`);

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
      console.log(`\nminted ${codes.length} invite codes:`);
      for (const code of codes) console.log(`  ${code}`);
      console.log("\nshare each code via a trusted channel — they are single-use.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
