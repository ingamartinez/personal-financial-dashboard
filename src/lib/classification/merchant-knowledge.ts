// #814 Phase 5c: merchant knowledge base — pay once, read forever.
//
// Global facts (business type, aliases, is_gateway) live on
// `merchant_knowledge`. The category a merchant belongs to is a per-user hint
// on `merchant_knowledge_hints` — a global slug either FK-fails or mis-files
// for a tenant who renamed their taxonomy.
//
// Keys are canonical_merchant, never the bank description or an opaque
// gateway string. Two purchases that both render as MERCADOPAGO COLOMBIA are
// not the same merchant.
//
// The hot path is a read. Backfill is a deterministic pass over classifications
// that already exist — not an inference pass, no model call.

import { and, eq, isNotNull, ne, notInArray } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { merchantKnowledge, merchantKnowledgeHints, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { canonicalizeMerchant } from "@/lib/insights/merchant-canonical";
import { createLogger } from "@/lib/logger";
import { loadReceiptsById } from "./evidence";
import { matchOpaqueGateway } from "./opaque-gateways";
import { asReason, receiptIdFromReason } from "./reason";

const log = createLogger({ module: "classification/merchant-knowledge" });

// Same bar as sweep prior-art for non-manual rows. Manual/manual_confirmed
// still wins on a single observation. Kept local so this module does not
// import sweep.ts (sweep imports us).
const HINT_MIN_AGREEING_ROWS = 2;
// Mirrors SYSTEM_OWNED_CATEGORY_SLUGS in ai.ts without importing it — the
// backfill script must not pull the Anthropic client.
const SYSTEM_OWNED_CATEGORY_SLUGS: ReadonlySet<string> = new Set(["adjustments"]);

export type MerchantKnowledgeKeyRow = {
  canonicalMerchant: string | null;
  merchant: string | null;
  descriptionRaw: string;
};

export type MerchantKnowledgeEntry = {
  canonicalMerchant: string;
  businessType: string | null;
  aliases: string[];
  isGateway: boolean;
  categorySlug: string | null;
};

/**
 * Merchant identity used as the KB key. Same cascade the sweep's prior-art
 * pass uses: stored canonical_merchant, else canonicalize(merchant), else
 * canonicalize(description_raw). Lower-cased so "OXXO" and "oxxo" collide.
 * Returns null when there is nothing usable to key on.
 */
export function canonicalMerchantKey(row: MerchantKnowledgeKeyRow): string | null {
  const key =
    row.canonicalMerchant ??
    canonicalizeMerchant(row.merchant) ??
    canonicalizeMerchant(row.descriptionRaw);
  return key ? key.toLowerCase() : null;
}

export function isOpaqueMerchantKey(key: string | null): boolean {
  if (!key) return false;
  return matchOpaqueGateway([key]) != null;
}

/**
 * One-row read for a (user, canonical_merchant). Returns null when the
 * merchant is unknown, when it is flagged as a gateway, or when the key
 * itself is an opaque gateway string.
 */
export async function lookupMerchantKnowledge(
  userId: number,
  canonicalMerchant: string,
  database: DB = defaultDb,
): Promise<MerchantKnowledgeEntry | null> {
  const key = canonicalMerchant.toLowerCase();
  if (isOpaqueMerchantKey(key)) return null;

  const [row] = await database
    .select({
      canonicalMerchant: merchantKnowledge.canonicalMerchant,
      businessType: merchantKnowledge.businessType,
      aliases: merchantKnowledge.aliases,
      isGateway: merchantKnowledge.isGateway,
      categorySlug: merchantKnowledgeHints.categorySlug,
    })
    .from(merchantKnowledge)
    .leftJoin(
      merchantKnowledgeHints,
      and(
        eq(merchantKnowledgeHints.canonicalMerchant, merchantKnowledge.canonicalMerchant),
        eq(merchantKnowledgeHints.userId, userId),
      ),
    )
    .where(eq(merchantKnowledge.canonicalMerchant, key))
    .limit(1);

  if (!row || row.isGateway) return null;
  return {
    canonicalMerchant: row.canonicalMerchant,
    businessType: row.businessType,
    aliases: row.aliases,
    isGateway: row.isGateway,
    categorySlug: row.categorySlug,
  };
}

/**
 * Snapshot of this user's category hints, indexed by canonical_merchant.
 * Fetched once per sweep/pipeline run so the hot path is a read, not a
 * re-derivation from transactions. Skips gateway-flagged rows and opaque
 * keys. Tenant-scoped: the query filters on userId.
 */
export async function fetchMerchantKnowledgeIndex(
  userId: number,
  database: DB = defaultDb,
): Promise<Map<string, string>> {
  const rows = await database
    .select({
      canonicalMerchant: merchantKnowledgeHints.canonicalMerchant,
      categorySlug: merchantKnowledgeHints.categorySlug,
      isGateway: merchantKnowledge.isGateway,
    })
    .from(merchantKnowledgeHints)
    .innerJoin(
      merchantKnowledge,
      eq(merchantKnowledge.canonicalMerchant, merchantKnowledgeHints.canonicalMerchant),
    )
    .where(eq(merchantKnowledgeHints.userId, userId));

  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.isGateway) continue;
    if (isOpaqueMerchantKey(row.canonicalMerchant)) continue;
    if (!row.categorySlug || row.categorySlug === "otros") continue;
    if (SYSTEM_OWNED_CATEGORY_SLUGS.has(row.categorySlug)) continue;
    index.set(row.canonicalMerchant, row.categorySlug);
  }
  return index;
}

type HintEvidence = { manualCount: number; totalCount: number };
type MerchantAccumulator = {
  aliases: Set<string>;
  byCategory: Map<string, HintEvidence>;
};

function resolveHintCategory(byCategory: Map<string, HintEvidence>): string | null {
  if (byCategory.size === 0) return null;
  const manualWinners = [...byCategory.entries()].filter(([, e]) => e.manualCount >= 1);
  if (manualWinners.length === 1) return manualWinners[0]![0];
  if (manualWinners.length > 1) return null;
  const weakWinners = [...byCategory.entries()].filter(
    ([, e]) => e.totalCount >= HINT_MIN_AGREEING_ROWS,
  );
  if (weakWinners.length === 1) return weakWinners[0]![0];
  return null;
}

export type BackfillMerchantKnowledgeOpts = {
  userId?: number;
  dryRun?: boolean;
};

export type BackfillMerchantKnowledgeResult = {
  merchantsUpserted: number;
  hintsUpserted: number;
  skippedOpaque: number;
  skippedAmbiguous: number;
  skippedNoKey: number;
};

/**
 * Zero-cost backfill: persist one KB row per distinct canonical_merchant
 * observed on existing non-otros, non-transfer, non-system classifications,
 * plus a per-user category hint when the same ranking as prior art produces
 * a unique winner. Idempotent — existing rows are left alone.
 */
export async function backfillMerchantKnowledge(
  opts: BackfillMerchantKnowledgeOpts = {},
  database: DB = defaultDb,
): Promise<BackfillMerchantKnowledgeResult> {
  const dryRun = opts.dryRun ?? false;
  const result: BackfillMerchantKnowledgeResult = {
    merchantsUpserted: 0,
    hintsUpserted: 0,
    skippedOpaque: 0,
    skippedAmbiguous: 0,
    skippedNoKey: 0,
  };

  const rows = await database
    .select({
      userId: transactions.userId,
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      canonicalMerchant: transactions.canonicalMerchant,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(
      and(
        opts.userId !== undefined ? eq(transactions.userId, opts.userId) : undefined,
        notDeleted(transactions.deletedAt),
        ne(transactions.channel, "transfer"),
        notInArray(transactions.categorySlug, ["otros", ...SYSTEM_OWNED_CATEGORY_SLUGS]),
        isNotNull(transactions.categorySlug),
      ),
    );

  const opaqueReceiptIdsByUser = new Map<number, number[]>();
  for (const row of rows) {
    if (!matchOpaqueGateway([row.descriptionRaw, row.merchant])) continue;
    const rid = receiptIdFromReason(asReason(row.classificationReason));
    if (rid == null) continue;
    const list = opaqueReceiptIdsByUser.get(row.userId) ?? [];
    list.push(rid);
    opaqueReceiptIdsByUser.set(row.userId, list);
  }
  const opaqueReceiptsByUser = new Map<number, Map<number, { merchant: string | null }>>();
  for (const [userId, ids] of opaqueReceiptIdsByUser) {
    opaqueReceiptsByUser.set(userId, await loadReceiptsById(userId, ids));
  }

  // Per-user so a tenant's taxonomy never leaks into another user's hint.
  const byUser = new Map<number, Map<string, MerchantAccumulator>>();
  const globalAliases = new Map<string, Set<string>>();

  for (const row of rows) {
    let keyRow: MerchantKnowledgeKeyRow;
    if (matchOpaqueGateway([row.descriptionRaw, row.merchant])) {
      const rid = receiptIdFromReason(asReason(row.classificationReason));
      const receiptMerchant =
        rid != null ? (opaqueReceiptsByUser.get(row.userId)?.get(rid)?.merchant ?? null) : null;
      if (!receiptMerchant) {
        result.skippedOpaque++;
        continue;
      }
      keyRow = {
        canonicalMerchant: null,
        merchant: receiptMerchant,
        descriptionRaw: receiptMerchant,
      };
    } else {
      keyRow = row;
    }

    const key = canonicalMerchantKey(keyRow);
    if (!key) {
      result.skippedNoKey++;
      continue;
    }
    if (isOpaqueMerchantKey(key)) {
      result.skippedOpaque++;
      continue;
    }
    if (!row.categorySlug) continue;

    const aliases = globalAliases.get(key) ?? new Set<string>();
    if (keyRow.merchant) aliases.add(keyRow.merchant);
    globalAliases.set(key, aliases);

    const perMerchant = byUser.get(row.userId) ?? new Map<string, MerchantAccumulator>();
    const acc = perMerchant.get(key) ?? { aliases: new Set<string>(), byCategory: new Map() };
    if (keyRow.merchant) acc.aliases.add(keyRow.merchant);
    const evidence = acc.byCategory.get(row.categorySlug) ?? { manualCount: 0, totalCount: 0 };
    evidence.totalCount++;
    if (row.classificationMethod === "manual" || row.classificationMethod === "manual_confirmed") {
      evidence.manualCount++;
    }
    acc.byCategory.set(row.categorySlug, evidence);
    perMerchant.set(key, acc);
    byUser.set(row.userId, perMerchant);
  }

  const merchantRows = [...globalAliases.entries()].map(([canonicalMerchant, aliases]) => ({
    canonicalMerchant,
    aliases: [...aliases],
  }));

  if (!dryRun && merchantRows.length > 0) {
    // Insert in chunks so a large prod backfill does not blow the bind limit.
    const chunkSize = 200;
    for (let i = 0; i < merchantRows.length; i += chunkSize) {
      const chunk = merchantRows.slice(i, i + chunkSize);
      const inserted = await database
        .insert(merchantKnowledge)
        .values(chunk.map((m) => ({ canonicalMerchant: m.canonicalMerchant, aliases: m.aliases })))
        .onConflictDoNothing({ target: merchantKnowledge.canonicalMerchant })
        .returning({ canonicalMerchant: merchantKnowledge.canonicalMerchant });
      result.merchantsUpserted += inserted.length;
    }
  } else {
    result.merchantsUpserted = merchantRows.length;
  }

  const hintRows: { userId: number; canonicalMerchant: string; categorySlug: string }[] = [];
  for (const [userId, perMerchant] of byUser) {
    for (const [canonicalMerchant, acc] of perMerchant) {
      const categorySlug = resolveHintCategory(acc.byCategory);
      if (!categorySlug) {
        result.skippedAmbiguous++;
        continue;
      }
      hintRows.push({ userId, canonicalMerchant, categorySlug });
    }
  }

  if (!dryRun && hintRows.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < hintRows.length; i += chunkSize) {
      const chunk = hintRows.slice(i, i + chunkSize);
      const inserted = await database
        .insert(merchantKnowledgeHints)
        .values(chunk)
        .onConflictDoNothing({
          target: [merchantKnowledgeHints.userId, merchantKnowledgeHints.canonicalMerchant],
        })
        .returning({ id: merchantKnowledgeHints.id });
      result.hintsUpserted += inserted.length;
    }
  } else {
    result.hintsUpserted = hintRows.length;
  }

  log.info(
    {
      dryRun,
      userId: opts.userId ?? "all",
      merchantsConsidered: merchantRows.length,
      hintsConsidered: hintRows.length,
      ...result,
      event: "merchant_knowledge_backfill_done",
    },
    "merchant knowledge backfill finished",
  );

  return result;
}
