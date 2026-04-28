import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CounterpartyKind } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared mock state — hoisted so factory closures work above top-level consts.
// ---------------------------------------------------------------------------
const queueMocks = vi.hoisted(() => {
  const addMock = vi.fn().mockResolvedValue({ id: "mock-job-id" });
  const queueInstance = { add: addMock };
  return { addMock, queueInstance };
});

// `revalidatePath` requires a Next.js request context that vitest's node
// environment does not provide. No-op it so we can unit-test actions directly.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Stub the session helper so we don't drag in NextAuth's Next.js runtime deps
// under vitest. Every action under test scopes to user 1 (bootstrap).
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
  getSessionUserOrNull: vi.fn().mockResolvedValue({
    id: 1,
    email: "test@test.local",
    name: "Test",
  }),
}));

// Stub the AI classifier lib so tests never hit the Anthropic API; individual
// tests drive the mock with mockResolvedValueOnce for each scenario.
vi.mock("@/lib/classification/ai", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/classification/ai")>("@/lib/classification/ai");
  return {
    ...actual,
    classifySingleWithAi: vi.fn(),
  };
});

// Stub the BullMQ queue so runAiClassifier tests don't need a live Redis.
vi.mock("@/lib/queue", () => ({
  createQueue: vi.fn().mockReturnValue(queueMocks.queueInstance),
}));

const {
  updateCounterparty,
  mergeCounterparty,
  splitCounterparty,
  createManualEntry,
  classifySingleWithAi,
  updateTransactionCategory,
  confirmClassification,
  archiveTransaction,
  restoreTransaction,
  createManualTransferGroup,
  updateTransactionInstallments,
  runAiClassifier,
  enqueueClassifyAllPending,
} = await import("./actions");
const { classifySingleWithAi: classifySingleWithAiLib } = await import("@/lib/classification/ai");
const mockAiClassifySingle = vi.mocked(classifySingleWithAiLib);

// Scoped so parallel test files don't wipe each other's counterparty rows.
// Matches by alias.value prefix OR display_name prefix so tests that mutate
// alias values (split) are still cleanable.
async function cleanup() {
  await db.execute(sql`
    DELETE FROM transactions WHERE external_id LIKE 'test-cp-action:%'
  `);
  await db.execute(sql`
    DELETE FROM counterparties
    WHERE id IN (
      SELECT counterparty_id FROM counterparty_aliases WHERE value LIKE 'test-cp-%'
    )
       OR display_name LIKE 'test-cp-%'
  `);
}

const TEST_USER_ID = 1;

async function seedCounterparty(args: {
  key: string;
  kind?: CounterpartyKind;
  displayName?: string;
  defaultCategory?: string | null;
}): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO counterparties (user_id, display_name, type, default_category_slug)
    VALUES (
      ${TEST_USER_ID},
      ${args.displayName ?? args.key},
      'unknown',
      ${args.defaultCategory ?? null}
    )
    RETURNING id
  `);
  await db.execute(sql`
    INSERT INTO counterparty_aliases (user_id, counterparty_id, kind, value)
    VALUES (
      ${TEST_USER_ID},
      ${rows[0].id},
      ${args.kind ?? "qr"}::counterparty_key_kind,
      ${args.key}
    )
  `);
  return rows[0].id;
}

async function seedTx(args: {
  counterpartyId: number;
  externalId: string;
  categorySlug?: string | null;
  method?: "unclassified" | "manual" | "rule";
  smsBody?: string;
}): Promise<number> {
  const [acc] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
  `);
  const rawData = args.smsBody ? JSON.stringify({ kind: "sms", sms: args.smsBody }) : "{}";
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency, description_raw,
      counterparty_id, category_slug, classification_method, source, external_id, raw_data
    ) VALUES (
      ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'test',
      ${args.counterpartyId},
      ${args.categorySlug ?? null},
      ${args.method ?? "unclassified"}::classification_method,
      'sms',
      ${args.externalId},
      ${rawData}::jsonb
    )
    RETURNING id
  `);
  return rows[0].id;
}

async function seedAlias(args: {
  counterpartyId: number;
  kind: CounterpartyKind;
  value: string;
}): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO counterparty_aliases (user_id, counterparty_id, kind, value)
    VALUES (
      ${TEST_USER_ID},
      ${args.counterpartyId},
      ${args.kind}::counterparty_key_kind,
      ${args.value}
    )
    RETURNING id
  `);
  return rows[0].id;
}

// Seeds a counterparty with NO aliases, so the caller can attach any combination
// via `seedAlias`. Display name must be prefixed so cleanup() reaches it.
async function seedBareCounterparty(args: {
  displayName: string;
  defaultCategory?: string | null;
}): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO counterparties (user_id, display_name, type, default_category_slug)
    VALUES (
      ${TEST_USER_ID},
      ${args.displayName},
      'unknown',
      ${args.defaultCategory ?? null}
    )
    RETURNING id
  `);
  return rows[0].id;
}

describe("updateCounterparty", () => {
  afterEach(cleanup);
  beforeEach(async () => {
    await cleanup();
  });

  it("renames counterparty and leaves tx categories untouched when no default set", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-0088044474" });
    const txId = await seedTx({
      counterpartyId: cpId,
      externalId: "test-cp-action:1",
    });

    const result = await updateCounterparty({
      id: cpId,
      displayName: "Panadería del Barrio",
      type: "merchant",
      defaultCategorySlug: null,
      notes: null,
    });

    expect(result.propagatedCount).toBe(0);

    const cp = await db.execute<{ display_name: string; type: string }>(sql`
      SELECT display_name, type FROM counterparties WHERE id = ${cpId}
    `);
    expect(cp[0].display_name).toBe("Panadería del Barrio");
    expect(cp[0].type).toBe("merchant");

    const tx = await db.execute<{
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT category_slug, classification_method FROM transactions WHERE id = ${txId}
    `);
    expect(tx[0].category_slug).toBeNull();
    expect(tx[0].classification_method).toBe("unclassified");
  });

  it("propagates default category to unclassified tx only (preserves manual classifications)", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-0088044474" });
    const unclassifiedTx = await seedTx({
      counterpartyId: cpId,
      externalId: "test-cp-action:unclass",
    });
    const manualTx = await seedTx({
      counterpartyId: cpId,
      externalId: "test-cp-action:manual",
      categorySlug: "salud",
      method: "manual",
    });

    const result = await updateCounterparty({
      id: cpId,
      displayName: "Panadería",
      type: "merchant",
      defaultCategorySlug: "alimentacion",
      notes: null,
    });

    expect(result.propagatedCount).toBe(1);

    const rows = await db.execute<{
      id: number;
      category_slug: string;
      classification_method: string;
    }>(sql`
      SELECT id, category_slug, classification_method
      FROM transactions WHERE id IN (${unclassifiedTx}, ${manualTx})
      ORDER BY id
    `);
    const unclass = rows.find((r) => r.id === unclassifiedTx)!;
    const manual = rows.find((r) => r.id === manualTx)!;
    expect(unclass.category_slug).toBe("alimentacion");
    expect(unclass.classification_method).toBe("rule");
    expect(manual.category_slug).toBe("salud");
    expect(manual.classification_method).toBe("manual");
  });

  it("throws on unknown category slug", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-0088044474" });
    await expect(
      updateCounterparty({
        id: cpId,
        displayName: "X",
        type: "unknown",
        defaultCategorySlug: "no-existe",
        notes: null,
      }),
    ).rejects.toThrow(/Category not found/);
  });

  it("rejects empty displayName via zod", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-0088044474" });
    await expect(
      updateCounterparty({
        id: cpId,
        displayName: "   ",
        type: "unknown",
        defaultCategorySlug: null,
        notes: null,
      }),
    ).rejects.toThrow();
  });

  it("updates across multiple tx linked to same counterparty", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-0088044474" });
    await seedTx({ counterpartyId: cpId, externalId: "test-cp-action:a" });
    await seedTx({ counterpartyId: cpId, externalId: "test-cp-action:b" });
    await seedTx({ counterpartyId: cpId, externalId: "test-cp-action:c" });

    const result = await updateCounterparty({
      id: cpId,
      displayName: "Shared",
      type: "merchant",
      defaultCategorySlug: "alimentacion",
      notes: null,
    });

    expect(result.propagatedCount).toBe(3);
  });
});

describe("mergeCounterparty", () => {
  afterEach(cleanup);
  beforeEach(async () => {
    await cleanup();
  });

  it("moves aliases and transactions from source to target, then deletes source", async () => {
    const sourceId = await seedCounterparty({
      key: "test-cp-source",
      kind: "name",
      displayName: "DILAN DEJANON",
    });
    const targetId = await seedCounterparty({
      key: "test-cp-target",
      kind: "account",
      displayName: "Cuenta *91218413213",
    });
    const sourceTxA = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:mA",
    });
    const sourceTxB = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:mB",
    });
    const targetTx = await seedTx({
      counterpartyId: targetId,
      externalId: "test-cp-action:mT",
    });

    const result = await mergeCounterparty({ sourceId, targetId });

    expect(result.movedTxCount).toBe(2);
    expect(result.movedAliasCount).toBe(1);
    expect(result.inheritedCategoryFromSource).toBe(false);

    // Source deleted
    const srcCheck = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM counterparties WHERE id = ${sourceId}
    `);
    expect(srcCheck[0].c).toBe(0);

    // All 3 tx now on target
    const txs = await db.execute<{ counterparty_id: number | null }>(sql`
      SELECT counterparty_id FROM transactions
      WHERE id IN (${sourceTxA}, ${sourceTxB}, ${targetTx})
    `);
    for (const row of txs) {
      expect(row.counterparty_id).toBe(targetId);
    }

    // Target has both aliases
    const aliases = await db.execute<{ kind: string; value: string }>(sql`
      SELECT kind::text, value FROM counterparty_aliases
      WHERE counterparty_id = ${targetId}
      ORDER BY kind
    `);
    expect(aliases).toHaveLength(2);
    expect(aliases.map((a) => a.kind).sort()).toEqual(["account", "name"]);
  });

  it("inherits defaultCategory from source when target has none", async () => {
    const sourceId = await seedCounterparty({
      key: "test-cp-src2",
      displayName: "Source",
      defaultCategory: "alimentacion",
    });
    const targetId = await seedCounterparty({
      key: "test-cp-tgt2",
      displayName: "Target",
    });

    const result = await mergeCounterparty({ sourceId, targetId });

    expect(result.inheritedCategoryFromSource).toBe(true);
    const rows = await db.execute<{ default_category_slug: string }>(sql`
      SELECT default_category_slug FROM counterparties WHERE id = ${targetId}
    `);
    expect(rows[0].default_category_slug).toBe("alimentacion");
  });

  it("does NOT override target's existing defaultCategory", async () => {
    const sourceId = await seedCounterparty({
      key: "test-cp-src3",
      displayName: "Source",
      defaultCategory: "alimentacion",
    });
    const targetId = await seedCounterparty({
      key: "test-cp-tgt3",
      displayName: "Target",
      defaultCategory: "transferencias",
    });

    const result = await mergeCounterparty({ sourceId, targetId });

    expect(result.inheritedCategoryFromSource).toBe(false);
    const rows = await db.execute<{ default_category_slug: string }>(sql`
      SELECT default_category_slug FROM counterparties WHERE id = ${targetId}
    `);
    expect(rows[0].default_category_slug).toBe("transferencias");
  });

  it("rejects merging a counterparty into itself", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-self" });
    await expect(mergeCounterparty({ sourceId: cpId, targetId: cpId })).rejects.toThrow();
  });

  it("throws when source or target does not exist", async () => {
    const cpId = await seedCounterparty({ key: "test-cp-exists" });
    await expect(mergeCounterparty({ sourceId: 999999, targetId: cpId })).rejects.toThrow(
      /Source counterparty not found/,
    );
    await expect(mergeCounterparty({ sourceId: cpId, targetId: 999999 })).rejects.toThrow(
      /Target counterparty not found/,
    );
  });

  it("accumulates hit_count from source into target", async () => {
    const sourceId = await seedCounterparty({
      key: "test-cp-hitA",
      displayName: "A",
    });
    const targetId = await seedCounterparty({
      key: "test-cp-hitB",
      displayName: "B",
    });
    await db.execute(sql`
      UPDATE counterparties SET hit_count = 5 WHERE id = ${sourceId}
    `);
    await db.execute(sql`
      UPDATE counterparties SET hit_count = 3 WHERE id = ${targetId}
    `);

    await mergeCounterparty({ sourceId, targetId });

    const rows = await db.execute<{ hit_count: number }>(sql`
      SELECT hit_count FROM counterparties WHERE id = ${targetId}
    `);
    expect(rows[0].hit_count).toBe(8);
  });
});

describe("splitCounterparty", () => {
  afterEach(cleanup);
  beforeEach(async () => {
    await cleanup();
  });

  // Real Bancolombia fixtures. Parsers match them to (kind=qr, value=0051234567)
  // and (kind=breb, value=3051234567) respectively. See sms-bancolombia.test.ts.
  const QR_SMS = (amount = "$92,000.00") =>
    `Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste ${amount} por codigo QR desde tu cuenta *6126 a la llave 0051234567 el 15/04/2026 a las 00:20. Con codigo QR es facil y de una. Dudas al 018000912345`;
  const BREB_SMS = (amount = "$50,000.00") =>
    `Bancolombia: ALEJANDRO, transferiste ${amount} a la llave 3051234567 desde tu cuenta *6126 a MARIA PAZ TORRES CARRILLO el 01/04/26 a las 13:22. Con Bre-b es de una y gratis. Dudas al 018000912345.`;

  it("extracts selected aliases into a new counterparty and reassigns matching txs", async () => {
    const sourceId = await seedBareCounterparty({
      displayName: "test-cp-split-merged-thing",
      defaultCategory: "alimentacion",
    });
    const qrAliasId = await seedAlias({
      counterpartyId: sourceId,
      kind: "qr",
      value: "0051234567",
    });
    const brebAliasId = await seedAlias({
      counterpartyId: sourceId,
      kind: "breb",
      value: "3051234567",
    });

    const qrTxA = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:qr-A",
      smsBody: QR_SMS("$10,000.00"),
    });
    const qrTxB = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:qr-B",
      smsBody: QR_SMS("$20,000.00"),
    });
    const brebTxA = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:breb-A",
      smsBody: BREB_SMS("$30,000.00"),
    });
    const brebTxB = await seedTx({
      counterpartyId: sourceId,
      externalId: "test-cp-action:breb-B",
      smsBody: BREB_SMS("$40,000.00"),
    });

    const result = await splitCounterparty({
      sourceId,
      aliasIds: [qrAliasId],
    });

    expect(result.movedAliasCount).toBe(1);
    expect(result.movedTxCount).toBe(2);
    expect(result.newCounterpartyId).not.toBe(sourceId);

    const aliasRows = await db.execute<{ id: number; counterparty_id: number; kind: string }>(sql`
      SELECT id, counterparty_id, kind::text
      FROM counterparty_aliases
      WHERE id IN (${qrAliasId}, ${brebAliasId})
      ORDER BY kind
    `);
    const byKind = Object.fromEntries(aliasRows.map((r) => [r.kind, r.counterparty_id]));
    expect(byKind.qr).toBe(result.newCounterpartyId);
    expect(byKind.breb).toBe(sourceId);

    const txRows = await db.execute<{ id: number; counterparty_id: number | null }>(sql`
      SELECT id, counterparty_id
      FROM transactions
      WHERE id IN (${qrTxA}, ${qrTxB}, ${brebTxA}, ${brebTxB})
      ORDER BY id
    `);
    const byId = Object.fromEntries(txRows.map((r) => [r.id, r.counterparty_id]));
    expect(byId[qrTxA]).toBe(result.newCounterpartyId);
    expect(byId[qrTxB]).toBe(result.newCounterpartyId);
    expect(byId[brebTxA]).toBe(sourceId);
    expect(byId[brebTxB]).toBe(sourceId);

    const newCp = await db.execute<{
      display_name: string;
      type: string;
      default_category_slug: string | null;
    }>(sql`
      SELECT display_name, type::text, default_category_slug
      FROM counterparties WHERE id = ${result.newCounterpartyId}
    `);
    expect(newCp[0].display_name).toBe("test-cp-split-merged-thing");
    expect(newCp[0].default_category_slug).toBe("alimentacion");
  });

  it("honors newDisplayName override for the new counterparty", async () => {
    const sourceId = await seedBareCounterparty({
      displayName: "test-cp-split-old-name",
    });
    const qrAliasId = await seedAlias({
      counterpartyId: sourceId,
      kind: "qr",
      value: "0051234567",
    });
    await seedAlias({
      counterpartyId: sourceId,
      kind: "breb",
      value: "3051234567",
    });

    const result = await splitCounterparty({
      sourceId,
      aliasIds: [qrAliasId],
      newDisplayName: "test-cp-split-fresh-name",
    });

    const newCp = await db.execute<{ display_name: string }>(sql`
      SELECT display_name FROM counterparties WHERE id = ${result.newCounterpartyId}
    `);
    expect(newCp[0].display_name).toBe("test-cp-split-fresh-name");
  });

  it("rejects extracting every alias (source would be left with none)", async () => {
    const sourceId = await seedBareCounterparty({
      displayName: "test-cp-split-all",
    });
    const qrId = await seedAlias({
      counterpartyId: sourceId,
      kind: "qr",
      value: "test-cp-splitall-qr",
    });
    const brebId = await seedAlias({
      counterpartyId: sourceId,
      kind: "breb",
      value: "test-cp-splitall-breb",
    });

    await expect(
      splitCounterparty({
        sourceId,
        aliasIds: [qrId, brebId],
      }),
    ).rejects.toThrow(/at least one must stay/);
  });

  it("rejects when source has only one alias", async () => {
    const sourceId = await seedBareCounterparty({
      displayName: "test-cp-split-single",
    });
    const aliasId = await seedAlias({
      counterpartyId: sourceId,
      kind: "qr",
      value: "test-cp-single-qr",
    });

    await expect(splitCounterparty({ sourceId, aliasIds: [aliasId] })).rejects.toThrow(
      /at least 2 aliases/,
    );
  });

  it("rejects aliasIds that don't belong to the source", async () => {
    const sourceId = await seedBareCounterparty({
      displayName: "test-cp-split-wrong-src",
    });
    await seedAlias({
      counterpartyId: sourceId,
      kind: "qr",
      value: "test-cp-wrong-src-qr",
    });
    await seedAlias({
      counterpartyId: sourceId,
      kind: "breb",
      value: "test-cp-wrong-src-breb",
    });
    const otherCpId = await seedBareCounterparty({
      displayName: "test-cp-split-other",
    });
    const otherAliasId = await seedAlias({
      counterpartyId: otherCpId,
      kind: "account",
      value: "test-cp-other-account",
    });

    await expect(splitCounterparty({ sourceId, aliasIds: [otherAliasId] })).rejects.toThrow(
      /do not belong to this counterparty/,
    );
  });

  it("throws when source does not exist", async () => {
    await expect(splitCounterparty({ sourceId: 9_999_999, aliasIds: [1] })).rejects.toThrow(
      /Source counterparty not found/,
    );
  });
});

describe("createManualEntry", () => {
  async function testAccountId(): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    return acc.id;
  }

  async function cleanupManualEntries() {
    await db.execute(sql`
      DELETE FROM transactions
      WHERE source = 'manual' AND description_raw LIKE 'test-manual-entry%'
    `);
  }

  afterEach(cleanupManualEntries);
  beforeEach(cleanupManualEntries);

  it("stores amount_cents as an exact bigint with no float rounding drift (expense)", async () => {
    const accountId = await testAccountId();

    // 1000.99 * 100 === 100099.00000000001 under IEEE-754; the old code
    // could have stored 100098 for certain similar values. Confirm the
    // cents value lands exactly.
    await createManualEntry({
      kind: "expense",
      accountId,
      amount: "1000.99",
      categorySlug: null,
      occurredOn: "2026-04-10",
      notes: "test-manual-entry exact cents",
    });

    const rows = await db.execute<{ amount_cents: string }>(sql`
      SELECT amount_cents::text AS amount_cents
      FROM transactions
      WHERE description_raw = 'test-manual-entry exact cents'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("-100099");
  });

  it("stores a positive amount_cents when kind=income", async () => {
    const accountId = await testAccountId();

    await createManualEntry({
      kind: "income",
      accountId,
      amount: "250000",
      categorySlug: null,
      occurredOn: "2026-04-10",
      notes: "test-manual-entry income deposit",
    });

    const rows = await db.execute<{ amount_cents: string }>(sql`
      SELECT amount_cents::text AS amount_cents
      FROM transactions
      WHERE description_raw = 'test-manual-entry income deposit'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("25000000");
  });

  it("uses 'Manual income' as the default description when notes are null (income)", async () => {
    const accountId = await testAccountId();

    await createManualEntry({
      kind: "income",
      accountId,
      amount: "100",
      categorySlug: null,
      occurredOn: "2026-04-10",
      notes: null,
    });

    // Scope by the default-description path so parallel cleanup doesn't eat
    // this row mid-test — seeded txns never use "Manual income".
    const rows = await db.execute<{ amount_cents: string }>(sql`
      SELECT amount_cents::text AS amount_cents
      FROM transactions
      WHERE description_raw = 'Manual income' AND source = 'manual'
      ORDER BY id DESC
      LIMIT 1
    `);
    expect(rows[0]?.amount_cents).toBe("10000");

    await db.execute(sql`
      DELETE FROM transactions
      WHERE description_raw = 'Manual income' AND source = 'manual'
    `);
  });

  it("logs entryKind in ingestion_logs.payload", async () => {
    const accountId = await testAccountId();

    await createManualEntry({
      kind: "income",
      accountId,
      amount: "42",
      categorySlug: null,
      occurredOn: "2026-04-10",
      notes: "test-manual-entry ingestion log",
    });

    const [row] = await db.execute<{ payload: { kind: string; entryKind: string } }>(sql`
      SELECT payload
      FROM ingestion_logs
      WHERE source = 'manual'
        AND (payload->>'accountId')::int = ${accountId}
      ORDER BY id DESC
      LIMIT 1
    `);
    expect(row.payload.kind).toBe("manual-create");
    expect(row.payload.entryKind).toBe("income");
  });

  it("rejects amounts with more than two decimal places", async () => {
    const accountId = await testAccountId();
    await expect(
      createManualEntry({
        kind: "expense",
        accountId,
        amount: "9.995",
        categorySlug: null,
        occurredOn: "2026-04-10",
        notes: "test-manual-entry bad-decimals",
      }),
    ).rejects.toThrow(/positive decimal/);
  });

  it("rejects negative amounts and non-numeric input", async () => {
    const accountId = await testAccountId();
    for (const bad of ["-5", "abc", ""]) {
      await expect(
        createManualEntry({
          kind: "expense",
          accountId,
          amount: bad,
          categorySlug: null,
          occurredOn: "2026-04-10",
          notes: "test-manual-entry bad-amount",
        }),
      ).rejects.toThrow(/positive decimal/);
    }
  });

  it("rejects zero amount", async () => {
    const accountId = await testAccountId();
    await expect(
      createManualEntry({
        kind: "expense",
        accountId,
        amount: "0",
        categorySlug: null,
        occurredOn: "2026-04-10",
        notes: "test-manual-entry zero",
      }),
    ).rejects.toThrow(/greater than zero/);
  });

  it("rejects future dates", async () => {
    const accountId = await testAccountId();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await expect(
      createManualEntry({
        kind: "expense",
        accountId,
        amount: "100",
        categorySlug: null,
        occurredOn: future,
        notes: "test-manual-entry future",
      }),
    ).rejects.toThrow(/future/);
  });

  it("accepts today and past dates", async () => {
    const accountId = await testAccountId();
    const today = new Date().toISOString().slice(0, 10);
    await createManualEntry({
      kind: "expense",
      accountId,
      amount: "50",
      categorySlug: null,
      occurredOn: today,
      notes: "test-manual-entry today",
    });
    const rows = await db.execute<{ amount_cents: string }>(sql`
      SELECT amount_cents::text AS amount_cents
      FROM transactions
      WHERE description_raw = 'test-manual-entry today'
    `);
    expect(rows[0].amount_cents).toBe("-5000");
  });

  it("handles the max-cents boundary used in the form ceiling", async () => {
    const accountId = await testAccountId();
    await createManualEntry({
      kind: "expense",
      accountId,
      amount: "9999999.99",
      categorySlug: null,
      occurredOn: "2026-04-10",
      notes: "test-manual-entry large",
    });
    const rows = await db.execute<{ amount_cents: string }>(sql`
      SELECT amount_cents::text AS amount_cents
      FROM transactions
      WHERE description_raw = 'test-manual-entry large'
    `);
    expect(rows[0].amount_cents).toBe("-999999999");
  });
});

describe("updateTransactionCategory", () => {
  async function seedTxWithMerchant(args: {
    externalId: string;
    merchant: string | null;
    categorySlug?: string | null;
    method?: "unclassified" | "manual" | "rule" | "ai";
  }): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        merchant, category_slug, classification_method, classification_confidence, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'test',
        ${args.merchant},
        ${args.categorySlug ?? null},
        ${args.method ?? "unclassified"}::classification_method,
        ${args.categorySlug ? 100 : null},
        'sms',
        ${args.externalId}
      )
      RETURNING id
    `);
    return rows[0].id;
  }

  async function cleanupUpdateCategoryTxs() {
    await db.execute(sql`
      DELETE FROM classification_corrections
      WHERE transaction_id IN (
        SELECT id FROM transactions WHERE external_id LIKE 'test-update-cat:%'
      )
    `);
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE 'test-update-cat:%'
    `);
    await db.execute(sql`
      UPDATE users SET classification_context = '{}'::jsonb WHERE id = ${TEST_USER_ID}
    `);
  }

  beforeEach(cleanupUpdateCategoryTxs);
  afterEach(cleanupUpdateCategoryTxs);

  it("records a correction row when user picks a new category on an unclassified tx", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:unclass",
      merchant: "CARULLA",
    });

    await updateTransactionCategory({ txId, categorySlug: "alimentacion" });

    const [row] = await db.execute<{
      category_slug: string;
      classification_method: string;
      classification_confidence: number;
      previous_category_slug: string | null;
    }>(sql`
      SELECT category_slug, classification_method, classification_confidence, previous_category_slug
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBe("alimentacion");
    expect(row.classification_method).toBe("manual");
    expect(row.classification_confidence).toBe(100);
    expect(row.previous_category_slug).toBeNull();

    const corrections = await db.execute<{
      merchant: string | null;
      previous_category_slug: string | null;
      new_category_slug: string;
    }>(sql`
      SELECT merchant, previous_category_slug, new_category_slug
      FROM classification_corrections
      WHERE transaction_id = ${txId}
    `);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].merchant).toBe("CARULLA");
    expect(corrections[0].previous_category_slug).toBeNull();
    expect(corrections[0].new_category_slug).toBe("alimentacion");
  });

  it("preserves prior category in previous_category_slug when re-categorizing", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:recat",
      merchant: "CARULLA",
      categorySlug: "alimentacion",
      method: "ai",
    });

    await updateTransactionCategory({ txId, categorySlug: "transferencias" });

    const [row] = await db.execute<{
      category_slug: string;
      previous_category_slug: string | null;
    }>(sql`
      SELECT category_slug, previous_category_slug
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBe("transferencias");
    expect(row.previous_category_slug).toBe("alimentacion");

    const corrections = await db.execute<{
      previous_category_slug: string | null;
      new_category_slug: string;
    }>(sql`
      SELECT previous_category_slug, new_category_slug
      FROM classification_corrections
      WHERE transaction_id = ${txId}
    `);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].previous_category_slug).toBe("alimentacion");
    expect(corrections[0].new_category_slug).toBe("transferencias");
  });

  it("does NOT log a correction when un-classifying to null", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:unset",
      merchant: "CARULLA",
      categorySlug: "alimentacion",
      method: "manual",
    });

    await updateTransactionCategory({ txId, categorySlug: null });

    const [row] = await db.execute<{
      category_slug: string | null;
      classification_method: string;
      classification_confidence: number | null;
      previous_category_slug: string | null;
    }>(sql`
      SELECT category_slug, classification_method, classification_confidence, previous_category_slug
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBeNull();
    expect(row.classification_method).toBe("unclassified");
    expect(row.classification_confidence).toBeNull();
    expect(row.previous_category_slug).toBe("alimentacion");

    const corrections = await db.execute(sql`
      SELECT 1 FROM classification_corrections WHERE transaction_id = ${txId}
    `);
    expect(corrections).toHaveLength(0);
  });

  it("is a no-op when the new slug matches the current slug", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:noop",
      merchant: "CARULLA",
      categorySlug: "alimentacion",
      method: "manual",
    });

    await updateTransactionCategory({ txId, categorySlug: "alimentacion" });

    const [row] = await db.execute<{ previous_category_slug: string | null }>(sql`
      SELECT previous_category_slug FROM transactions WHERE id = ${txId}
    `);
    expect(row.previous_category_slug).toBeNull();

    const corrections = await db.execute(sql`
      SELECT 1 FROM classification_corrections WHERE transaction_id = ${txId}
    `);
    expect(corrections).toHaveLength(0);
  });

  it("appends a rolling merchant hint on correction and trims to the most recent 50", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:hint",
      merchant: "CARULLA",
    });

    // Pre-seed classification_context with 50 hints so the 51st correction
    // triggers the rolling FIFO trim. Hints older than slot 1 should drop.
    const hints = Array.from({ length: 50 }, (_, i) => ({
      merchant: `OLD-${i}`,
      category: "alimentacion",
      corrected_at: new Date(Date.now() - (50 - i) * 60_000).toISOString(),
    }));
    await db.execute(sql`
      UPDATE users
      SET classification_context = ${JSON.stringify({ merchant_hints: hints })}::jsonb
      WHERE id = ${TEST_USER_ID}
    `);

    await updateTransactionCategory({ txId, categorySlug: "alimentacion" });

    const [row] = await db.execute<{
      classification_context: { merchant_hints?: Array<{ merchant: string; category: string }> };
    }>(sql`
      SELECT classification_context FROM users WHERE id = ${TEST_USER_ID}
    `);
    const storedHints = row.classification_context.merchant_hints ?? [];
    expect(storedHints).toHaveLength(50);
    // Oldest hint (OLD-0) dropped; newest is the CARULLA we just wrote.
    expect(storedHints[0]?.merchant).toBe("OLD-1");
    expect(storedHints[49]?.merchant).toBe("CARULLA");
    expect(storedHints[49]?.category).toBe("alimentacion");
  });

  it("skips the merchant hint when merchant is null", async () => {
    const txId = await seedTxWithMerchant({
      externalId: "test-update-cat:nomerchant",
      merchant: null,
    });

    await updateTransactionCategory({ txId, categorySlug: "alimentacion" });

    const [row] = await db.execute<{
      classification_context: { merchant_hints?: unknown[] };
    }>(sql`
      SELECT classification_context FROM users WHERE id = ${TEST_USER_ID}
    `);
    expect(row.classification_context.merchant_hints ?? []).toHaveLength(0);
  });

  it("silently no-ops when txId does not exist (no correction, no throw)", async () => {
    await expect(
      updateTransactionCategory({ txId: 9_999_999, categorySlug: "alimentacion" }),
    ).resolves.toBeUndefined();

    const corrections = await db.execute(sql`
      SELECT 1 FROM classification_corrections WHERE transaction_id = 9999999
    `);
    expect(corrections).toHaveLength(0);
  });
});

describe("confirmClassification", () => {
  async function seedAutoTx(args: {
    externalId: string;
    method: "rule" | "ai" | "manual";
    categorySlug: string;
    confidence: number;
  }): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        merchant, category_slug, classification_method, classification_confidence, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'test',
        'TEST-CONFIRM',
        ${args.categorySlug},
        ${args.method}::classification_method,
        ${args.confidence},
        'sms',
        ${args.externalId}
      )
      RETURNING id
    `);
    return rows[0].id;
  }

  async function cleanupConfirmTxs() {
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE 'test-confirm:%'
    `);
  }

  beforeEach(cleanupConfirmTxs);
  afterEach(cleanupConfirmTxs);

  it("promotes an ai classification to manual_confirmed with confidence 100", async () => {
    const txId = await seedAutoTx({
      externalId: "test-confirm:ai",
      method: "ai",
      categorySlug: "alimentacion",
      confidence: 45,
    });

    const result = await confirmClassification({ txId });
    expect(result).toEqual({ status: "ok" });

    const [row] = await db.execute<{
      classification_method: string;
      classification_confidence: number;
    }>(sql`
      SELECT classification_method, classification_confidence FROM transactions WHERE id = ${txId}
    `);
    expect(row.classification_method).toBe("manual_confirmed");
    expect(row.classification_confidence).toBe(100);
  });

  it("refuses to confirm a manually-classified transaction", async () => {
    const txId = await seedAutoTx({
      externalId: "test-confirm:manual",
      method: "manual",
      categorySlug: "alimentacion",
      confidence: 100,
    });

    const result = await confirmClassification({ txId });
    expect(result).toEqual({
      status: "error",
      message: "Transacción no está pendiente de revisión.",
    });

    const [row] = await db.execute<{ classification_method: string }>(sql`
      SELECT classification_method FROM transactions WHERE id = ${txId}
    `);
    expect(row.classification_method).toBe("manual");
  });

  it("returns error when tx does not exist", async () => {
    const result = await confirmClassification({ txId: 9_999_999 });
    expect(result).toEqual({
      status: "error",
      message: "Transacción no está pendiente de revisión.",
    });
  });
});

describe("classifySingleWithAi", () => {
  async function seedUnclassifiedTx(externalId: string): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${acc.id}, now(), -42000, 'COP', 'NETFLIX',
        'unclassified'::classification_method, 'sms', ${externalId}
      )
      RETURNING id
    `);
    return rows[0].id;
  }

  async function seedClassifiedTx(externalId: string): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        category_slug, classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'manual already',
        'alimentacion', 'manual'::classification_method, 'sms', ${externalId}
      )
      RETURNING id
    `);
    return rows[0].id;
  }

  async function cleanupAiTxs() {
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE 'test-ai-single:%'
    `);
  }

  beforeEach(async () => {
    await cleanupAiTxs();
    mockAiClassifySingle.mockReset();
  });
  afterEach(cleanupAiTxs);

  it("updates tx with category, method='ai', and confidence on success", async () => {
    const txId = await seedUnclassifiedTx("test-ai-single:ok");
    mockAiClassifySingle.mockResolvedValueOnce({
      classification: {
        id: txId,
        categorySlug: "suscripciones",
        confidence: 92,
        reason: "NETFLIX",
      },
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await classifySingleWithAi({ txId });

    expect(result.categorySlug).toBe("suscripciones");
    expect(result.confidence).toBe(92);
    expect(result.categoryName.length).toBeGreaterThan(0);

    const [row] = await db.execute<{
      category_slug: string;
      classification_method: string;
      classification_confidence: number;
    }>(sql`
      SELECT category_slug, classification_method, classification_confidence
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBe("suscripciones");
    expect(row.classification_method).toBe("ai");
    expect(row.classification_confidence).toBe(92);
  });

  it("rejects when tx is already classified and does not call the AI", async () => {
    const txId = await seedClassifiedTx("test-ai-single:classified");

    await expect(classifySingleWithAi({ txId })).rejects.toThrow(/already classified/);
    expect(mockAiClassifySingle).not.toHaveBeenCalled();

    const [row] = await db.execute<{
      category_slug: string;
      classification_method: string;
    }>(sql`
      SELECT category_slug, classification_method
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBe("alimentacion");
    expect(row.classification_method).toBe("manual");
  });

  it("rejects when tx does not exist", async () => {
    await expect(classifySingleWithAi({ txId: 9_999_999 })).rejects.toThrow(/not found/);
    expect(mockAiClassifySingle).not.toHaveBeenCalled();
  });

  it("rejects and leaves tx unclassified when AI returns null category", async () => {
    const txId = await seedUnclassifiedTx("test-ai-single:null");
    mockAiClassifySingle.mockResolvedValueOnce({
      classification: {
        id: txId,
        categorySlug: null,
        confidence: 10,
      },
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    await expect(classifySingleWithAi({ txId })).rejects.toThrow(/could not classify/);

    const [row] = await db.execute<{
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT category_slug, classification_method
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBeNull();
    expect(row.classification_method).toBe("unclassified");
  });

  it("rejects when the AI returns a slug that isn't in the category taxonomy", async () => {
    const txId = await seedUnclassifiedTx("test-ai-single:bogus");
    mockAiClassifySingle.mockResolvedValueOnce({
      classification: {
        id: txId,
        categorySlug: "not-a-real-slug",
        confidence: 80,
      },
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    await expect(classifySingleWithAi({ txId })).rejects.toThrow();

    const [row] = await db.execute<{
      category_slug: string | null;
      classification_method: string;
    }>(sql`
      SELECT category_slug, classification_method
      FROM transactions WHERE id = ${txId}
    `);
    expect(row.category_slug).toBeNull();
    expect(row.classification_method).toBe("unclassified");
  });

  it("rejects an invalid txId via zod", async () => {
    await expect(classifySingleWithAi({ txId: 0 })).rejects.toThrow();
    await expect(classifySingleWithAi({ txId: -1 })).rejects.toThrow();
  });
});

describe("archiveTransaction / restoreTransaction (#375)", () => {
  const EXT_PREFIX = "test-cp-action:archive";
  async function archiveCleanup() {
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE ${EXT_PREFIX + "%"}
    `);
  }
  beforeEach(archiveCleanup);
  afterEach(archiveCleanup);

  async function accountState(accountId: number) {
    const [row] = await db.execute<{
      balance: string;
      live_count: number;
      total_count: number;
    }>(sql`
      SELECT
        COALESCE(SUM(amount_cents) FILTER (WHERE deleted_at IS NULL), 0)::text AS balance,
        COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS live_count,
        COUNT(*)::int AS total_count
      FROM transactions
      WHERE account_id = ${accountId} AND external_id LIKE ${EXT_PREFIX + "%"}
    `);
    return {
      balanceCents: BigInt(row.balance),
      liveCount: row.live_count,
      totalCount: row.total_count,
    };
  }

  it("archive excludes the tx from the derived balance; restore brings it back", async () => {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const txId = await seedTx({
      counterpartyId: await seedBareCounterparty({ displayName: "test-cp-archive-1" }),
      externalId: `${EXT_PREFIX}:balance`,
    });

    const before = await accountState(acc.id);
    expect(before.balanceCents).toBe(BigInt(-5000));
    expect(before.liveCount).toBe(1);

    const archived = await archiveTransaction({ txId });
    expect(archived).toEqual({ status: "ok" });

    const afterArchive = await accountState(acc.id);
    expect(afterArchive.balanceCents).toBe(BigInt(0));
    expect(afterArchive.liveCount).toBe(0);
    expect(afterArchive.totalCount).toBe(1);

    const restored = await restoreTransaction({ txId });
    expect(restored).toEqual({ status: "ok" });

    const afterRestore = await accountState(acc.id);
    expect(afterRestore.balanceCents).toBe(BigInt(-5000));
    expect(afterRestore.liveCount).toBe(1);
  });

  it("archive is idempotent (second call returns not-found)", async () => {
    const txId = await seedTx({
      counterpartyId: await seedBareCounterparty({ displayName: "test-cp-archive-2" }),
      externalId: `${EXT_PREFIX}:idempotent`,
    });
    const first = await archiveTransaction({ txId });
    expect(first).toEqual({ status: "ok" });
    const second = await archiveTransaction({ txId });
    expect(second).toEqual({ status: "not-found" });
  });

  it("restore on a live tx is a no-op (returns not-found)", async () => {
    const txId = await seedTx({
      counterpartyId: await seedBareCounterparty({ displayName: "test-cp-archive-3" }),
      externalId: `${EXT_PREFIX}:no-restore`,
    });
    const result = await restoreTransaction({ txId });
    expect(result).toEqual({ status: "not-found" });
  });

  it("re-ingesting the same externalId after archive does NOT duplicate the row (unique index still sees archived)", async () => {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const txId = await seedTx({
      counterpartyId: await seedBareCounterparty({ displayName: "test-cp-archive-4" }),
      externalId: `${EXT_PREFIX}:dedup`,
    });
    await archiveTransaction({ txId });

    // Mirror the ingestion dedup path: INSERT … ON CONFLICT DO NOTHING on
    // the same (account_id, external_id) partial unique index.
    const [row] = await db.execute<{ inserted: number }>(sql`
      WITH ins AS (
        INSERT INTO transactions (
          user_id, account_id, occurred_at, amount_cents, currency,
          description_raw, classification_method, source, external_id, raw_data
        ) VALUES (
          ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'resurrected',
          'unclassified'::classification_method, 'sms', ${EXT_PREFIX + ":dedup"}, '{}'::jsonb
        )
        ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
        RETURNING id
      )
      SELECT count(*)::int AS inserted FROM ins
    `);
    expect(row.inserted).toBe(0);

    // Archived row is still the only row — dedup did NOT resurrect or duplicate.
    const state = await accountState(acc.id);
    expect(state.totalCount).toBe(1);
    expect(state.liveCount).toBe(0);
  });
});

// #405: archive / restore cascade across transfer_group_id. Prevents "half-
// archived" groups that would break the Σ=0 invariant and leave account
// balances internally inconsistent.
describe("archiveTransaction / restoreTransaction over transfer groups (#405)", () => {
  const EXT_PREFIX = "test-cp-action:tgarchive";
  async function cleanup() {
    await db.execute(sql`DELETE FROM transactions WHERE external_id LIKE ${EXT_PREFIX + "%"}`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);

  async function seedPairedGroup(suffix: string): Promise<{
    originId: number;
    destId: number;
    groupId: string;
  }> {
    const [savings] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const [tc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Visa *2575' LIMIT 1
    `);
    const [groupRow] = await db.execute<{ id: string }>(sql`SELECT gen_random_uuid()::text AS id`);
    const groupId = groupRow.id;

    const [origin] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, channel, transfer_group_id, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${savings.id}, now(), -500000, 'COP', 'Pago TC *2575',
        'manual'::classification_method, 'sms', 'transfer'::tx_channel,
        ${groupId}::uuid, ${`${EXT_PREFIX}:${suffix}`}
      )
      RETURNING id
    `);
    const [dest] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, channel, transfer_group_id, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${tc.id}, now(), 500000, 'COP', 'Pago TC *2575',
        'manual'::classification_method, 'sms', 'transfer'::tx_channel,
        ${groupId}::uuid, ${`${EXT_PREFIX}:${suffix}`}
      )
      RETURNING id
    `);
    return { originId: origin.id, destId: dest.id, groupId };
  }

  it("archiving one leg archives every sibling in the group atomically", async () => {
    const { originId, destId, groupId } = await seedPairedGroup("cascade-archive");

    const result = await archiveTransaction({ txId: originId });
    expect(result).toEqual({ status: "ok" });

    const liveLegs = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions
      WHERE transfer_group_id = ${groupId}::uuid AND deleted_at IS NULL
    `);
    expect(liveLegs[0].n).toBe("0");

    // And the sibling is actually archived (not just filtered).
    const [sibling] = await db.execute<{ deleted_at: string | null }>(sql`
      SELECT deleted_at FROM transactions WHERE id = ${destId}
    `);
    expect(sibling.deleted_at).not.toBeNull();
  });

  it("restoring one leg restores every sibling in the group atomically", async () => {
    const { originId, destId, groupId } = await seedPairedGroup("cascade-restore");
    await archiveTransaction({ txId: originId });

    const result = await restoreTransaction({ txId: destId });
    expect(result).toEqual({ status: "ok" });

    const liveLegs = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions
      WHERE transfer_group_id = ${groupId}::uuid AND deleted_at IS NULL
    `);
    expect(liveLegs[0].n).toBe("2");
  });

  it("cascade does NOT touch transactions outside the group", async () => {
    const { originId } = await seedPairedGroup("cascade-isolation");
    const standaloneId = await seedTx({
      counterpartyId: await seedBareCounterparty({ displayName: "test-cp-archive-isolation" }),
      externalId: `${EXT_PREFIX}:standalone`,
    });

    await archiveTransaction({ txId: originId });

    const [standalone] = await db.execute<{ deleted_at: string | null }>(sql`
      SELECT deleted_at FROM transactions WHERE id = ${standaloneId}
    `);
    expect(standalone.deleted_at).toBeNull();
  });
});

// #405: manual transfer-group creation via /transactions UI. Covers the
// balance / currency / account-distinctness invariants and the happy paths
// for 1-to-1 and 1-to-N.
describe("createManualTransferGroup (#405)", () => {
  async function cleanup() {
    await db.execute(sql`
      DELETE FROM transactions WHERE raw_data @> '{"manualTransfer": true}'
    `);
  }
  beforeEach(cleanup);
  afterEach(cleanup);

  async function savingsId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    return row.id;
  }
  async function visaId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Visa *2575' LIMIT 1
    `);
    return row.id;
  }
  async function mastercardCopId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts
      WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Mastercard *7291' AND currency = 'COP'
      LIMIT 1
    `);
    return row.id;
  }
  async function usdId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'ARQ Ahorros' LIMIT 1
    `);
    return row.id;
  }

  it("creates a 1-to-1 group with Σ=0 and channel=transfer on every leg", async () => {
    const origin = await savingsId();
    const dest = await visaId();
    const result = await createManualTransferGroup({
      origin: { accountId: origin, amount: "50000" },
      destinations: [{ accountId: dest, amount: "50000" }],
      occurredOn: "2026-04-15",
      description: "Manual pago TC",
      notes: null,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const legs = await db.execute<{
      amount_cents: string;
      channel: string;
      category_slug: string | null;
    }>(sql`
      SELECT amount_cents::text, channel, category_slug
      FROM transactions WHERE transfer_group_id = ${result.transferGroupId}::uuid
      ORDER BY amount_cents ASC
    `);
    expect(legs.length).toBe(2);
    for (const leg of legs) {
      expect(leg.channel).toBe("transfer");
      expect(leg.category_slug).toBeNull();
    }
    expect(BigInt(legs[0].amount_cents) + BigInt(legs[1].amount_cents)).toBe(BigInt(0));
  });

  it("creates a 1-to-N group (compra de cartera shape: 1 debit + 2 credits)", async () => {
    const origin = await savingsId();
    const [destA, destB] = [await visaId(), await mastercardCopId()];
    const result = await createManualTransferGroup({
      origin: { accountId: origin, amount: "100000" },
      destinations: [
        { accountId: destA, amount: "40000" },
        { accountId: destB, amount: "60000" },
      ],
      occurredOn: "2026-04-15",
      description: "Compra de cartera",
      notes: null,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.txIds.length).toBe(3);
  });

  it("rejects an unbalanced group (|debit| ≠ Σ|credit|)", async () => {
    const origin = await savingsId();
    const dest = await visaId();
    const result = await createManualTransferGroup({
      origin: { accountId: origin, amount: "50000" },
      destinations: [{ accountId: dest, amount: "49000" }],
      occurredOn: "2026-04-15",
      description: "Bad",
      notes: null,
    });
    expect(result.status).toBe("error");
  });

  it("rejects a group whose origin matches one of the destinations", async () => {
    const origin = await savingsId();
    const result = await createManualTransferGroup({
      origin: { accountId: origin, amount: "1000" },
      destinations: [{ accountId: origin, amount: "1000" }],
      occurredOn: "2026-04-15",
      description: "Self",
      notes: null,
    });
    expect(result.status).toBe("error");
  });

  it("rejects a cross-currency group", async () => {
    const originCop = await savingsId();
    const destUsd = await usdId();
    const result = await createManualTransferGroup({
      origin: { accountId: originCop, amount: "1000" },
      destinations: [{ accountId: destUsd, amount: "1000" }],
      occurredOn: "2026-04-15",
      description: "FX",
      notes: null,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/currency/i);
  });

  it("rejects a future-dated group", async () => {
    const origin = await savingsId();
    const dest = await visaId();
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const result = await createManualTransferGroup({
      origin: { accountId: origin, amount: "1000" },
      destinations: [{ accountId: dest, amount: "1000" }],
      occurredOn: future,
      description: "Future",
      notes: null,
    });
    expect(result.status).toBe("error");
  });
});

// #406: installments + rate per tx — the "edit cuotas" flow from /transactions.
// Covers: happy path, rate snapshot on TC tx, rejection of suspiciously low
// EM values, and the account-type gate.
describe("updateTransactionInstallments (#406)", () => {
  const EXT_PREFIX = "test-cp-action:installments";
  async function cleanup() {
    await db.execute(sql`DELETE FROM transactions WHERE external_id LIKE ${EXT_PREFIX + "%"}`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);

  async function seedTcTx(externalId: string): Promise<number> {
    const [tc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Visa *2575' LIMIT 1
    `);
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${tc.id}, now(), -2479900, 'COP', 'MercadoPago L',
        'unclassified'::classification_method, 'sms', ${externalId}
      )
      RETURNING id
    `);
    return row.id;
  }

  async function seedSavingsTx(externalId: string): Promise<number> {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${acc.id}, now(), -50000, 'COP', 'test',
        'unclassified'::classification_method, 'manual', ${externalId}
      )
      RETURNING id
    `);
    return row.id;
  }

  it("updates installments and snapshots the rate on a TC tx", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:happy`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });
    expect(result.status).toBe("ok");

    const [row] = await db.execute<{
      installments_total: number;
      installment_rate_bps: number | null;
    }>(sql`
      SELECT installments_total, installment_rate_bps FROM transactions WHERE id = ${txId}
    `);
    expect(row.installments_total).toBe(12);
    // #411: the DB column name stays `installment_rate_bps`, but the unit
    // is now percent × 10000 — 19110 = 1.9110% EM.
    expect(row.installment_rate_bps).toBe(19110);
  });

  it("accepts a null rate for 1 cuota (no interest — diferido sin intereses)", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:one-cuota-null`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 1,
      installmentRateEmX10k: null,
    });
    expect(result.status).toBe("ok");

    const [row] = await db.execute<{
      installments_total: number;
      installment_rate_bps: number | null;
    }>(sql`
      SELECT installments_total, installment_rate_bps FROM transactions WHERE id = ${txId}
    `);
    expect(row.installments_total).toBe(1);
    expect(row.installment_rate_bps).toBeNull();
  });

  it("rejects null rate when cuotas > 1 (#416 — no silent bucket fallback)", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:multi-null-rejected`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 6,
      installmentRateEmX10k: null,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/obligatoria/i);
    }
  });

  it("rejects suspiciously low EM values (likely EA mislabeled as EM)", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:low-rate`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 3,
      installmentRateEmX10k: 2500, // 0.25% EM — almost certainly EA mistaken as EM
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/EM/);
  });

  it("accepts 0 as a valid rate (diferido sin intereses)", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:zero`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 9,
      installmentRateEmX10k: 0,
    });
    expect(result.status).toBe("ok");
  });

  it("refuses to update a tx whose account is not a credit_card", async () => {
    const txId = await seedSavingsTx(`${EXT_PREFIX}:savings`);
    const result = await updateTransactionInstallments({
      txId,
      installmentsTotal: 3,
      installmentRateEmX10k: 19110,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/tarjeta/i);
  });

  it("rejects installments out of range (0 or > 120)", async () => {
    const txId = await seedTcTx(`${EXT_PREFIX}:range`);
    const zero = await updateTransactionInstallments({
      txId,
      installmentsTotal: 0,
      installmentRateEmX10k: null,
    });
    expect(zero.status).toBe("error");
    const tooMany = await updateTransactionInstallments({
      txId,
      installmentsTotal: 500,
      installmentRateEmX10k: null,
    });
    expect(tooMany.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// runAiClassifier — now enqueues instead of processing inline (#590)
// ---------------------------------------------------------------------------

describe("runAiClassifier (#590)", () => {
  const EXT_PREFIX = "test-run-ai-classifier";

  async function defaultAccountId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    return row.id;
  }

  async function seedUnclassifiedTx(externalId: string): Promise<number> {
    const accountId = await defaultAccountId();
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency,
        description_raw, classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${accountId}, now(), -10000, 'COP',
        'runAiClassifier-test', 'unclassified'::classification_method,
        'sms', ${externalId}
      )
      RETURNING id
    `);
    return row.id;
  }

  async function cleanupRunAiTxs() {
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE ${EXT_PREFIX + ":%"}
    `);
  }

  beforeEach(async () => {
    await cleanupRunAiTxs();
    queueMocks.addMock.mockClear();
  });
  afterEach(cleanupRunAiTxs);

  it("enqueues a classify-tx job with mode=specific and the pending tx IDs", async () => {
    const txId = await seedUnclassifiedTx(`${EXT_PREFIX}:one`);

    const result = await runAiClassifier();

    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(queueMocks.addMock).toHaveBeenCalledOnce();

    const [, jobData] = queueMocks.addMock.mock.calls[0];
    expect(jobData.mode).toBe("specific");
    expect(jobData.userId).toBe(TEST_USER_ID);
    expect(Array.isArray(jobData.txIds)).toBe(true);
    expect(jobData.txIds).toContain(txId);
  });

  it("returns { enqueued: 0 } and does NOT call queue.add when nothing is pending", async () => {
    // No unclassified txs seeded
    const result = await runAiClassifier();

    expect(result.enqueued).toBe(0);
    expect(queueMocks.addMock).not.toHaveBeenCalled();
  });

  it("enqueues at most AI_BATCH_SIZE transactions per call", async () => {
    // Seed 25 unclassified txs — more than AI_BATCH_SIZE (20)
    for (let i = 0; i < 25; i++) {
      await seedUnclassifiedTx(`${EXT_PREFIX}:batch-${i}`);
    }

    const result = await runAiClassifier();

    expect(result.enqueued).toBeLessThanOrEqual(20);
    expect(queueMocks.addMock).toHaveBeenCalledOnce();

    const [, jobData] = queueMocks.addMock.mock.calls[0];
    expect(jobData.txIds).toHaveLength(result.enqueued);
    expect(jobData.txIds.length).toBeLessThanOrEqual(20);
  });

  it("does NOT process the transactions synchronously (no DB updates)", async () => {
    const txId = await seedUnclassifiedTx(`${EXT_PREFIX}:no-inline`);

    await runAiClassifier();

    // The tx must still be unclassified — only the queue.add was called
    const [row] = await db.execute<{ classification_method: string }>(sql`
      SELECT classification_method FROM transactions WHERE id = ${txId}
    `);
    expect(row.classification_method).toBe("unclassified");
  });
});

// ---------------------------------------------------------------------------
// enqueueClassifyAllPending — enqueues ONE drain-pending job (#592)
// ---------------------------------------------------------------------------

describe("enqueueClassifyAllPending (#592)", () => {
  const EXT_PREFIX = "test-drain-all-pending";

  async function defaultAccountId(): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    return row.id;
  }

  async function seedUnclassifiedTx(externalId: string): Promise<number> {
    const accountId = await defaultAccountId();
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency,
        description_raw, classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_ID}, ${accountId}, now(), -10000, 'COP',
        'drain-all-test', 'unclassified'::classification_method,
        'sms', ${externalId}
      )
      RETURNING id
    `);
    return row.id;
  }

  async function cleanupDrainTxs() {
    await db.execute(sql`
      DELETE FROM transactions WHERE external_id LIKE ${EXT_PREFIX + ":%"}
    `);
  }

  beforeEach(async () => {
    await cleanupDrainTxs();
    queueMocks.addMock.mockClear();
  });
  afterEach(cleanupDrainTxs);

  it("returns { enqueued: 0 } and does NOT call queue.add when nothing is pending", async () => {
    // No unclassified txs seeded for this user (cleanup ran above)
    const result = await enqueueClassifyAllPending();

    expect(result.enqueued).toBe(0);
    expect(queueMocks.addMock).not.toHaveBeenCalled();
  });

  it("enqueues a classify-tx job with mode=drain-pending when there are pending txs", async () => {
    await seedUnclassifiedTx(`${EXT_PREFIX}:one`);

    const result = await enqueueClassifyAllPending();

    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(queueMocks.addMock).toHaveBeenCalledOnce();

    const [, jobData, jobOpts] = queueMocks.addMock.mock.calls[0];
    expect(jobData.mode).toBe("drain-pending");
    expect(jobData.userId).toBe(TEST_USER_ID);
    // drain-pending carries no txIds — the worker fetches them incrementally
    expect("txIds" in jobData).toBe(false);
    // Idempotent jobId
    expect(jobOpts.jobId).toBe(`drain-${TEST_USER_ID}`);
  });

  it("returns the total pending count (not capped at batch size)", async () => {
    // Seed 25 txs — more than AI_BATCH_SIZE (20); drain-all should report ALL
    for (let i = 0; i < 25; i++) {
      await seedUnclassifiedTx(`${EXT_PREFIX}:batch-${i}`);
    }

    const result = await enqueueClassifyAllPending();

    // enqueued = total pending, which is at least our 25 seeded rows
    expect(result.enqueued).toBeGreaterThanOrEqual(25);
    // Only one job added regardless of pending count
    expect(queueMocks.addMock).toHaveBeenCalledOnce();
  });

  it("uses a per-user idempotent jobId (drain-<userId>)", async () => {
    await seedUnclassifiedTx(`${EXT_PREFIX}:idem`);

    await enqueueClassifyAllPending();

    const [, , opts] = queueMocks.addMock.mock.calls[0];
    expect(opts.jobId).toBe(`drain-${TEST_USER_ID}`);
  });

  it("does NOT update any transaction rows synchronously", async () => {
    const txId = await seedUnclassifiedTx(`${EXT_PREFIX}:no-inline`);

    await enqueueClassifyAllPending();

    const [row] = await db.execute<{ classification_method: string }>(sql`
      SELECT classification_method FROM transactions WHERE id = ${txId}
    `);
    expect(row.classification_method).toBe("unclassified");
  });
});
