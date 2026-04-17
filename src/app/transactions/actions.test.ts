import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// `revalidatePath` requires a Next.js request context that vitest's node
// environment does not provide. No-op it so we can unit-test actions directly.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { updateCounterparty, mergeCounterparty, splitCounterparty } = await import("./actions");

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

async function seedCounterparty(args: {
  key: string;
  kind?: "qr" | "breb" | "account" | "name";
  displayName?: string;
  defaultCategory?: string | null;
}): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO counterparties (display_name, type, default_category_slug)
    VALUES (
      ${args.displayName ?? args.key},
      'unknown',
      ${args.defaultCategory ?? null}
    )
    RETURNING id
  `);
  await db.execute(sql`
    INSERT INTO counterparty_aliases (counterparty_id, kind, value)
    VALUES (
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
      account_id, occurred_at, amount_cents, currency, description_raw,
      counterparty_id, category_slug, classification_method, source, external_id, raw_data
    ) VALUES (
      ${acc.id}, now(), -5000, 'COP', 'test',
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
  kind: "qr" | "breb" | "account" | "name";
  value: string;
}): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO counterparty_aliases (counterparty_id, kind, value)
    VALUES (
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
    INSERT INTO counterparties (display_name, type, default_category_slug)
    VALUES (
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
