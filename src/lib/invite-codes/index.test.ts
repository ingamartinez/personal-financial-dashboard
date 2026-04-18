import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inviteCodes, users } from "@/lib/db/schema";
import {
  consumeInviteCode,
  generateInviteCode,
  getInviteStatus,
  listInviteCodesFor,
  mintInviteCode,
  validateInviteCode,
} from "./index";

const TEST_USER_EMAIL = "__invite_test_user@example.com";
const TEST_CODE_PREFIX = "__INVTEST__";

async function cleanup() {
  await db.execute(sql`DELETE FROM invite_codes WHERE code LIKE ${TEST_CODE_PREFIX + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${TEST_USER_EMAIL}`);
}

async function seedUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email: TEST_USER_EMAIL, name: "Invite Test" })
    .returning({ id: users.id });
  return u.id;
}

async function seedCode(opts: {
  code: string;
  createdByUserId: number;
  maxUses?: number;
  usesCount?: number;
  expiresAt?: Date | null;
}) {
  const [row] = await db
    .insert(inviteCodes)
    .values({
      code: opts.code,
      createdByUserId: opts.createdByUserId,
      maxUses: opts.maxUses ?? 1,
      usesCount: opts.usesCount ?? 0,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();
  return row;
}

describe("generateInviteCode", () => {
  it("produces 24-char strings from the Crockford base32 alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(24);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    }
  });

  it("is not deterministic across calls", () => {
    const a = generateInviteCode();
    const b = generateInviteCode();
    expect(a).not.toBe(b);
  });
});

describe("getInviteStatus", () => {
  const base = {
    code: "X",
    createdByUserId: 1,
    createdAt: new Date("2026-01-01"),
  };
  const now = new Date("2026-05-01T12:00:00Z");

  it("returns expired when expires_at is in the past, regardless of uses", () => {
    expect(
      getInviteStatus(
        { ...base, maxUses: 5, usesCount: 0, expiresAt: new Date("2026-04-01") },
        now,
      ),
    ).toBe("expired");
  });

  it("returns exhausted when uses_count >= max_uses", () => {
    expect(getInviteStatus({ ...base, maxUses: 1, usesCount: 1, expiresAt: null }, now)).toBe(
      "exhausted",
    );
    expect(getInviteStatus({ ...base, maxUses: 5, usesCount: 5, expiresAt: null }, now)).toBe(
      "exhausted",
    );
  });

  it("returns partially-used when 0 < uses < max_uses", () => {
    expect(getInviteStatus({ ...base, maxUses: 5, usesCount: 2, expiresAt: null }, now)).toBe(
      "partially-used",
    );
  });

  it("returns unused when uses_count is 0", () => {
    expect(getInviteStatus({ ...base, maxUses: 5, usesCount: 0, expiresAt: null }, now)).toBe(
      "unused",
    );
  });
});

describe("validateInviteCode (integration)", () => {
  let userId: number;
  beforeEach(async () => {
    await cleanup();
    userId = await seedUser();
  });
  afterEach(cleanup);

  it("returns unknown for a non-existent code", async () => {
    const r = await validateInviteCode(`${TEST_CODE_PREFIX}NOPE`);
    expect(r).toEqual({ ok: false, reason: "unknown" });
  });

  it("returns expired when expires_at is in the past", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}EXP`,
      createdByUserId: userId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await validateInviteCode(`${TEST_CODE_PREFIX}EXP`);
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("returns exhausted when uses_count >= max_uses", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}EXH`,
      createdByUserId: userId,
      maxUses: 1,
      usesCount: 1,
    });
    const r = await validateInviteCode(`${TEST_CODE_PREFIX}EXH`);
    expect(r).toEqual({ ok: false, reason: "exhausted" });
  });

  it("returns ok with the row for a valid code", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}OK`,
      createdByUserId: userId,
      maxUses: 3,
      usesCount: 0,
    });
    const r = await validateInviteCode(`${TEST_CODE_PREFIX}OK`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.code).toBe(`${TEST_CODE_PREFIX}OK`);
      expect(r.row.maxUses).toBe(3);
    }
  });
});

describe("consumeInviteCode (integration)", () => {
  let userId: number;
  beforeEach(async () => {
    await cleanup();
    userId = await seedUser();
  });
  afterEach(cleanup);

  it("increments uses_count and returns the updated row on a valid consume", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}C1`,
      createdByUserId: userId,
      maxUses: 2,
      usesCount: 0,
    });
    const r = await consumeInviteCode(`${TEST_CODE_PREFIX}C1`);
    expect(r).not.toBeNull();
    expect(r?.usesCount).toBe(1);
  });

  it("returns null when the code is unknown", async () => {
    const r = await consumeInviteCode(`${TEST_CODE_PREFIX}NOPE`);
    expect(r).toBeNull();
  });

  it("returns null when the code is exhausted and does not increment past max_uses", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}EXH`,
      createdByUserId: userId,
      maxUses: 1,
      usesCount: 1,
    });
    const r = await consumeInviteCode(`${TEST_CODE_PREFIX}EXH`);
    expect(r).toBeNull();
    const [after] = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, `${TEST_CODE_PREFIX}EXH`));
    expect(after.usesCount).toBe(1);
  });

  it("returns null when the code is expired", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}EXP`,
      createdByUserId: userId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await consumeInviteCode(`${TEST_CODE_PREFIX}EXP`);
    expect(r).toBeNull();
  });

  it("is atomic under concurrent consumes of a max_uses=1 code — exactly one wins", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}RACE`,
      createdByUserId: userId,
      maxUses: 1,
      usesCount: 0,
    });
    const [a, b, c] = await Promise.all([
      consumeInviteCode(`${TEST_CODE_PREFIX}RACE`),
      consumeInviteCode(`${TEST_CODE_PREFIX}RACE`),
      consumeInviteCode(`${TEST_CODE_PREFIX}RACE`),
    ]);
    const winners = [a, b, c].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const [after] = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, `${TEST_CODE_PREFIX}RACE`));
    expect(after.usesCount).toBe(1);
  });

  it("allows multiple consumes until max_uses is reached, then rejects", async () => {
    await seedCode({
      code: `${TEST_CODE_PREFIX}MULTI`,
      createdByUserId: userId,
      maxUses: 3,
      usesCount: 0,
    });
    expect(await consumeInviteCode(`${TEST_CODE_PREFIX}MULTI`)).not.toBeNull();
    expect(await consumeInviteCode(`${TEST_CODE_PREFIX}MULTI`)).not.toBeNull();
    expect(await consumeInviteCode(`${TEST_CODE_PREFIX}MULTI`)).not.toBeNull();
    expect(await consumeInviteCode(`${TEST_CODE_PREFIX}MULTI`)).toBeNull();
  });
});

describe("mintInviteCode (integration)", () => {
  let userId: number;
  beforeEach(async () => {
    await cleanup();
    userId = await seedUser();
  });
  afterEach(cleanup);

  it("inserts a row scoped to the creating user with the requested maxUses and expiry", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const row = await mintInviteCode({ createdByUserId: userId, maxUses: 5, expiresAt });
    expect(row.createdByUserId).toBe(userId);
    expect(row.maxUses).toBe(5);
    expect(row.usesCount).toBe(0);
    expect(row.expiresAt?.getTime()).toBe(expiresAt.getTime());
    // cleanup targets LIKE prefix so scrub manually
    await db.execute(sql`DELETE FROM invite_codes WHERE code = ${row.code}`);
  });

  it("defaults maxUses to 1 and expiresAt to null", async () => {
    const row = await mintInviteCode({ createdByUserId: userId });
    expect(row.maxUses).toBe(1);
    expect(row.expiresAt).toBeNull();
    await db.execute(sql`DELETE FROM invite_codes WHERE code = ${row.code}`);
  });

  it("rejects maxUses < 1", async () => {
    await expect(mintInviteCode({ createdByUserId: userId, maxUses: 0 })).rejects.toThrow();
  });
});

describe("listInviteCodesFor (integration)", () => {
  let userId: number;
  beforeEach(async () => {
    await cleanup();
    userId = await seedUser();
  });
  afterEach(cleanup);

  it("returns only codes created by the given user, newest first", async () => {
    const a = await seedCode({ code: `${TEST_CODE_PREFIX}A`, createdByUserId: userId });
    // tiny gap so createdAt differs
    await new Promise((r) => setTimeout(r, 5));
    const b = await seedCode({ code: `${TEST_CODE_PREFIX}B`, createdByUserId: userId });

    const rows = await listInviteCodesFor(userId);
    const ourRows = rows.filter((r) => r.code.startsWith(TEST_CODE_PREFIX));
    expect(ourRows.map((r) => r.code)).toEqual([b.code, a.code]);
  });
});
