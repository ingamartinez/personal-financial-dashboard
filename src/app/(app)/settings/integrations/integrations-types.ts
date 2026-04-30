// Shared types for the integrations settings page.
// Kept in a separate file from actions.ts so they can be imported by client
// components — "use server" rejects non-async exports (#498, nextjs16 rule).

export type SetBootstrapSinceDateResult = { ok: true };
export type TriggerPullResult = { triggered: true; jobId: string | null };
