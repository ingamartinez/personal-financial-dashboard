/**
 * Guard for converting JSONB creditLimitCents to BigInt.
 *
 * AccountMetadata.creditLimitCents lives in JSONB (typed as `number`), so a
 * stale write could store a float. `BigInt(float)` throws a RangeError, so we
 * validate before converting.
 *
 * Returns the value as bigint when the input is a safe positive integer, or
 * null otherwise (no limit configured / invalid data).
 */
export function safeLimitCents(limit: number | undefined | null): bigint | null {
  if (typeof limit !== "number") return null;
  if (!Number.isInteger(limit)) return null;
  if (limit <= 0) return null;
  return BigInt(limit);
}
