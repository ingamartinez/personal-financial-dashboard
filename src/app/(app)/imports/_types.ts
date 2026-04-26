// Shared types for the /imports page.
// Kept in a separate file from actions.ts so client components can import them
// without triggering the "use server" non-async-export restriction.
// Memory: nextjs16-use-server-async-only, nextjs16-server-action-types-split

export type StatementFormat = "arq";

export interface ImportPreviewResult {
  token: string;
  accountLabel: string;
  period: {
    start: string; // ISO date string
    end: string;
  };
  parsedCount: number;
  balanceCheck: {
    ok: boolean;
    declaredStartCents: string; // serialized as string (bigint JSON safe)
    declaredEndCents: string;
    declaredCreditsCents: string;
    declaredDebitsCents: string;
    parsedSumCents: string;
    diffCents: string;
    errors: string[];
    warnings: string[];
  };
  chainCheck: {
    chainOk: boolean | null;
    previousEndCents: string | null;
    currentStartCents: string;
    diffCents: string | null;
  };
  mergePreview: {
    parsedCount: number;
    /** Estimate: txs that are likely email matches (not a real dry-run). */
    estimatedMergeCount: number;
  };
  errors: string[];
}

export interface ImportCommitResult {
  status: "committed" | "reconcile_failed" | "already_imported" | "expired" | "error";
  importId?: number;
  insertedCount?: number;
  mergedCount?: number;
  flaggedCount?: number;
  emailOrphanCount?: number;
  period?: { start: string; end: string };
  error?: string;
}
