/**
 * Pure-JS Levenshtein utilities.
 *
 * No external dependencies — kept intentionally small. The primary consumer is
 * the ARQ statement reconciler (#517) which uses `levenshteinRatio` to fuzzy-
 * match counterparty names between email receipts and statement lines.
 *
 * Performance: O(m × n) time and O(min(m,n)) space (single-row optimisation).
 * For the expected string lengths (< 100 chars) this is negligible.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Case-insensitive: both inputs are lower-cased before comparison so that
 * "Maria Eugenia" and "maria eugenia" have distance 0.
 */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();

  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // Keep only a single row (current) and one value (prev diagonal) to stay O(min(m,n)) space.
  const m = s.length;
  const n = t.length;

  // Iterate over the shorter string as columns to minimise memory.
  const [src, dst, sLen, dLen] = m <= n ? [s, t, m, n] : [t, s, n, m];

  // row[j] = edit distance(src[0..i], dst[0..j]) after processing row i.
  const row = new Array<number>(sLen + 1);
  for (let j = 0; j <= sLen; j++) row[j] = j;

  for (let i = 1; i <= dLen; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= sLen; j++) {
      const temp = row[j];
      row[j] = dst[i - 1] === src[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = temp;
    }
  }

  return row[sLen];
}

/**
 * Normalised similarity ratio in [0, 1].
 *
 * Defined as:
 *   ratio = 1 − distance / max(len(a), len(b))
 *
 * Returns 1.0 for identical strings, 0.0 when the longer string must be
 * completely rewritten to produce the shorter.
 *
 * Empty-string edge case: both empty → 1.0 (perfect match); one empty → 0.0.
 */
export function levenshteinRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
