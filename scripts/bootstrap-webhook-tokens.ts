import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, webhookTokens } from "@/lib/db/schema";
import { mintWebhookToken, type WebhookPurpose } from "@/lib/webhook-tokens";

const PURPOSES: readonly WebhookPurpose[] = ["sms", "debug"] as const;

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

async function hasActiveToken(userId: number, purpose: WebhookPurpose): Promise<boolean> {
  const [existing] = await db
    .select({ id: webhookTokens.id })
    .from(webhookTokens)
    .where(
      and(
        eq(webhookTokens.userId, userId),
        eq(webhookTokens.purpose, purpose),
        isNull(webhookTokens.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

export async function bootstrapWebhookTokens(): Promise<
  Array<{ purpose: WebhookPurpose; plaintext: string | null; skipped: boolean }>
> {
  const bootstrap = await resolveBootstrapUser();
  console.log(`bootstrap user: ${bootstrap.email} (id=${bootstrap.id})`);

  const results: Array<{ purpose: WebhookPurpose; plaintext: string | null; skipped: boolean }> =
    [];
  for (const purpose of PURPOSES) {
    if (await hasActiveToken(bootstrap.id, purpose)) {
      console.log(`  ${purpose}: active token already exists — skipping`);
      results.push({ purpose, plaintext: null, skipped: true });
      continue;
    }
    const { plaintext } = await mintWebhookToken({
      userId: bootstrap.id,
      purpose,
      label: "bootstrap",
    });
    results.push({ purpose, plaintext, skipped: false });
  }
  return results;
}

if (import.meta.main) {
  bootstrapWebhookTokens()
    .then((results) => {
      const minted = results.filter((r) => !r.skipped);
      if (minted.length === 0) {
        console.log("\nnothing minted — revoke any existing token first to re-issue.");
      } else {
        console.log(`\nminted ${minted.length} tokens:`);
        for (const r of minted) {
          console.log(`  ${r.purpose}: ${r.plaintext}`);
        }
        console.log("\nstore each — the plaintext will not be retrievable again.");
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
