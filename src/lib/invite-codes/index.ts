import { randomInt } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { inviteCodes } from "@/lib/db/schema";

export type InviteCodeRow = {
  code: string;
  createdByUserId: number | null;
  maxUses: number;
  usesCount: number;
  expiresAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
};

export type InviteStatus = "unused" | "partially-used" | "exhausted" | "expired" | "disabled";

export type InviteValidation =
  | { ok: true; row: InviteCodeRow }
  | { ok: false; reason: "unknown" | "expired" | "exhausted" | "disabled" };

// 20 bytes → 32 Crockford-base32 chars. Human-copyable, no ambiguous O/0/I/1.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 24;

export function generateInviteCode(): string {
  // randomInt uses rejection sampling under the hood, so it is unbiased over
  // any range — unlike `randomBytes[i] % ALPHABET.length`, which CodeQL flags
  // as biased even when ALPHABET.length divides 256.
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * Classifies a code for UI purposes. The authoritative gate is
 * `consumeInviteCode` — this is purely a display helper.
 */
export function getInviteStatus(row: InviteCodeRow, now: Date = new Date()): InviteStatus {
  if (row.disabledAt) return "disabled";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.usesCount >= row.maxUses) return "exhausted";
  if (row.usesCount > 0) return "partially-used";
  return "unused";
}

/**
 * Read-only precheck for `/signup?code=XYZ` — surfaces a friendly error BEFORE
 * setting the cookie and kicking off OAuth. Do NOT rely on this for the actual
 * gate; `consumeInviteCode` is the atomic enforcement.
 */
export async function validateInviteCode(
  code: string,
  database: DB = defaultDb,
): Promise<InviteValidation> {
  const [row] = await database
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.disabledAt) return { ok: false, reason: "disabled" };
  const now = new Date();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (row.usesCount >= row.maxUses) return { ok: false, reason: "exhausted" };
  return { ok: true, row };
}

/**
 * Atomic single-use consumption. Returns the updated row on success, null if
 * the code is unknown, expired, or already exhausted. Race-safe because the
 * `uses_count < max_uses` predicate is inside the UPDATE; two concurrent
 * callers trying to consume a max_uses=1 code serialize and only one wins.
 */
export async function consumeInviteCode(
  code: string,
  database: DB = defaultDb,
): Promise<InviteCodeRow | null> {
  const result = await database
    .update(inviteCodes)
    .set({ usesCount: sql`${inviteCodes.usesCount} + 1` })
    .where(
      and(
        eq(inviteCodes.code, code),
        sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
        sql`(${inviteCodes.expiresAt} IS NULL OR ${inviteCodes.expiresAt} > now())`,
        sql`${inviteCodes.disabledAt} IS NULL`,
      ),
    )
    .returning();
  return result[0] ?? null;
}

/**
 * Flip `disabled_at` for a code owned by `ownerUserId`. Idempotent — if the
 * code is already in the requested state, returns the current row. Returns
 * null if the code doesn't exist or isn't owned by the caller.
 */
export async function setInviteDisabled(
  opts: { code: string; ownerUserId: number; disabled: boolean },
  database: DB = defaultDb,
): Promise<InviteCodeRow | null> {
  const result = await database
    .update(inviteCodes)
    .set({ disabledAt: opts.disabled ? new Date() : null })
    .where(and(eq(inviteCodes.code, opts.code), eq(inviteCodes.createdByUserId, opts.ownerUserId)))
    .returning();
  return result[0] ?? null;
}

export async function mintInviteCode(
  opts: {
    createdByUserId: number;
    maxUses?: number;
    expiresAt?: Date | null;
  },
  database: DB = defaultDb,
): Promise<InviteCodeRow> {
  const maxUses = opts.maxUses ?? 1;
  if (maxUses < 1) throw new Error("maxUses must be >= 1");
  // PK is the code string itself; retry on the unlikely collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [row] = await database
        .insert(inviteCodes)
        .values({
          code: generateInviteCode(),
          createdByUserId: opts.createdByUserId,
          maxUses,
          expiresAt: opts.expiresAt ?? null,
        })
        .returning();
      return row;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505" && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("mintInviteCode: exhausted retries generating a unique code");
}

export async function listInviteCodesFor(
  userId: number,
  database: DB = defaultDb,
): Promise<InviteCodeRow[]> {
  return database
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.createdByUserId, userId))
    .orderBy(desc(inviteCodes.createdAt));
}
