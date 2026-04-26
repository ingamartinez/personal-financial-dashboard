import { z } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "types/fx-metadata" });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Canonical FX metadata shape stored in `transactions.rawData.fx`.
 *
 * All producers (email-arq.ts, arq-statement/reconciler.ts) write this block.
 * All consumers (intra-user-pair.ts, convert.ts) read through parseFxMetadata.
 *
 * Key invariants:
 *  - `originalAmountCents` is a bigint serialised as a numeric string for JSON
 *    round-trip safety (JSON does not support BigInt natively).
 *  - `trmToAccountCurrency` is the ratio COP per 1 unit of the account's native
 *    currency. null when currencies are identical (1:1). When present it is the
 *    FROZEN TRM captured at the time of the transaction — not the live rate.
 *  - `copAmountCents` is optional; present only when the producer had both legs
 *    of a cross-currency transfer (e.g. email parser saw both USDc and COP).
 *
 * Shape is byte-compatible with what is already stored in production. DO NOT
 * rename keys without a backfill migration.
 */
export const FxMetadataSchema = z.object({
  originalCurrency: z.enum(["USD", "USDc", "COP"]),
  /** bigint serialised as a numeric string for JSON round-trip safety. */
  originalAmountCents: z.string().regex(/^\d+$/, "must be a non-negative integer string"),
  /**
   * Ratio: COP per 1 unit of account currency.
   * null when no conversion applies (same currency, 1:1).
   */
  trmToAccountCurrency: z.number().nullable(),
  trmSource: z.enum(["1_to_1", "email_implied", "statement_frozen", "user_input", "unknown"]),
  /**
   * Mirror of originalAmountCents converted to COP (string for bigint).
   * Present only when the producer observed both legs of a cross-currency
   * transfer. Consumers must treat absence as "TRM-derived only".
   */
  copAmountCents: z.string().regex(/^\d+$/).optional(),
});

export type FxMetadata = z.infer<typeof FxMetadataSchema>;

// ---------------------------------------------------------------------------
// Safe accessor
// ---------------------------------------------------------------------------

/**
 * Parse an unknown value into FxMetadata.
 *
 * Returns null on shape mismatch and logs a structured event so we can
 * detect gaps in the pipeline without crashing. Callers must handle null
 * gracefully (fall back to current TRM or display as-is).
 */
export function parseFxMetadata(value: unknown): FxMetadata | null {
  const result = FxMetadataSchema.safeParse(value);
  if (result.success) return result.data;

  log.warn(
    {
      parseError: result.error.format(),
      event: "fx_metadata_parse_failed",
    },
    "rawData.fx did not match FxMetadataSchema — treating as missing",
  );
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract and parse `rawData.fx` from a transaction's raw JSON.
 * Returns null when rawData is null/undefined or the fx block is absent or invalid.
 */
export function extractFxMetadata(
  rawData: Record<string, unknown> | null | undefined,
): FxMetadata | null {
  if (!rawData) return null;
  const fx = rawData.fx;
  if (fx === undefined || fx === null) return null;
  return parseFxMetadata(fx);
}

/**
 * Extract `rawData.merged_statement.fx` (statement-side override) if present,
 * falling back to `rawData.fx` (email-side primary). This mirrors the resolution
 * order in intra-user-pair.ts:extractArqMeta.
 */
export function extractFxMetadataWithFallback(
  rawData: Record<string, unknown> | null | undefined,
): FxMetadata | null {
  if (!rawData) return null;

  // Try statement-merged fx first (most authoritative — has frozen TRM from PDF).
  const merged = rawData.merged_statement as Record<string, unknown> | undefined;
  if (merged?.fx !== undefined && merged.fx !== null) {
    const parsed = parseFxMetadata(merged.fx);
    if (parsed !== null) return parsed;
  }

  // Fall back to primary fx block.
  return extractFxMetadata(rawData);
}
