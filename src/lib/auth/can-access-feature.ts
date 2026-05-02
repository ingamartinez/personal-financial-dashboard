import { createLogger } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = createLogger({ module: "auth/can-access-feature" });

export type PremiumFeature =
  | "cdt-suggestion"
  | "fic-suggestion"
  | "monthly-claude-report"
  | "conversational-insights";

/**
 * Premium feature gating — wired here per Epic #255 plan (FIRST premium-gated sub-issue).
 *
 * v1: always returns true (no Premium tier active yet).
 * Phase 7: replace with query against user_subscriptions table.
 *
 * See PLAN.md § Business Model & Pricing (Deferred) and issue #255.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function canAccessFeature(userId: number, feature: PremiumFeature): Promise<boolean> {
  return true;
}
