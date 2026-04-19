import { NextResponse } from "next/server";

export type CanIngestResult = { allowed: true } | { allowed: false; reason: string };

// Phase 7 (SaaS productization) seam. v1 is a no-op — every ingest is allowed.
// When Phase 7 flips, this reads users.subscription_status / trial_ends_at and
// denies when the subscription is past_due or canceled past grace period.
// See PLAN.md § Business Model & Pricing (Deferred) and issue #247.
export async function canIngest(_userId: number): Promise<CanIngestResult> {
  return { allowed: true };
}

export function paywallResponse(reason: string) {
  return NextResponse.json({ ok: false, status: "paywall", reason }, { status: 402 });
}
