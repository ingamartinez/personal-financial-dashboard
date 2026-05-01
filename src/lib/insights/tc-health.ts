/**
 * Pure TC health-check logic — no DB, no side effects.
 *
 * Consumed by two callers:
 *  1. The daily cron worker (`src/lib/queue/workers/tc-health-check.ts`) that
 *     emits notifications for each triggered card.
 *  2. The `/insights` page card that runs the same logic in real-time for the
 *     signed-in user.
 *
 * Two alert kinds are detected:
 *  - Statement cutoff approaching: `daysToCutoff` in [0, 3].
 *    "0" means today is the cutoff day. Negative (cutoff already passed this
 *    cycle) produces no alert — the next cycle begins immediately.
 *  - Utilization threshold crossed: highest of 80 / 90 / 95% crossed.
 *    Only the highest bucket is returned (additive by entityId in the worker,
 *    but `computeTcAlerts` returns the worst tier, not all tiers).
 *
 * Multi-currency cards with `cutoffDay = null` AND `creditLimitCents = 0` are
 * silently skipped by callers — there is nothing to alert on (no cutoff, no cupo).
 */

export type TcAlertTrigger = "statement" | "util-80" | "util-90" | "util-95";

export type TcCardSnapshot = {
  /** physicalCard.id (uuid) prefixed "pc-" OR account.id (number) prefixed "acc-" */
  cardId: string;
  kind: "physical" | "account";
  /** Ready-formatted card name for display and notification titles */
  label: string;
  cutoffDay: number | null;
  /**
   * Currency of creditLimitCents and usedCents.
   * Multi-currency physical cards aggregate all debt into COP.
   * Single-currency accounts carry their native currency (COP or USD).
   */
  currency: "COP" | "USD";
  creditLimitCents: bigint;
  usedCents: bigint;
  /** Pre-computed — roundUtilizationPct(usedCents, creditLimitCents) */
  utilizationPct: number;
  /** Days to next statement cutoff as of `today`, or null if cutoffDay is null */
  daysToCutoff: number | null;
};

/** Number of days before the statement cutoff that triggers the alert */
const STATEMENT_WINDOW_DAYS = 3;

/** Utilization thresholds in ascending order */
const UTIL_THRESHOLDS = [80, 90, 95] as const;

/**
 * Given a snapshot, return the list of alert triggers that have fired.
 * Order: utilization alert first (if any), then statement alert.
 *
 * Rules:
 * - Util: returns AT MOST ONE trigger — the highest bucket crossed. A card at
 *   92% gets `["util-90"]`, not `["util-80", "util-90"]`. The worker assigns
 *   distinct entityIds per bucket so crossing 95% later still fires a new
 *   notification.
 * - Statement: fires when `daysToCutoff` is in [0, STATEMENT_WINDOW_DAYS].
 *   daysToCutoff < 0 (cutoff already passed) → no alert.
 * - Cards with `creditLimitCents = 0` AND `cutoffDay = null` return [].
 */
export function computeTcAlerts(snapshot: TcCardSnapshot): TcAlertTrigger[] {
  const triggers: TcAlertTrigger[] = [];

  // Utilization check — highest bucket only
  for (let i = UTIL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (snapshot.utilizationPct >= UTIL_THRESHOLDS[i]!) {
      triggers.push(`util-${UTIL_THRESHOLDS[i]}` as TcAlertTrigger);
      break;
    }
  }

  // Statement cutoff check
  if (
    snapshot.daysToCutoff !== null &&
    snapshot.daysToCutoff >= 0 &&
    snapshot.daysToCutoff <= STATEMENT_WINDOW_DAYS
  ) {
    triggers.push("statement");
  }

  return triggers;
}
