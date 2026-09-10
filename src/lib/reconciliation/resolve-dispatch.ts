import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import type { ParsedStatement } from "./parsers/types";

export type ReconcileDispatchAccount = {
  id: number;
  currency: "COP" | "USD";
  institutionSlug: string;
  physicalCardId: string | null;
};

export type ReconcileDispatch = {
  origin: ReconcileDispatchAccount;
  sibling: ReconcileDispatchAccount | null;
};

async function loadReconcileSibling(
  userId: number,
  physicalCardId: string,
  excludeAccountId: number,
): Promise<ReconcileDispatchAccount | null> {
  const [sibling] = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.physicalCardId, physicalCardId),
        ne(accounts.id, excludeAccountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  return sibling ?? null;
}

// #444 — decides whether a parsed statement must dispatch to the origin
// account alone (single-currency) or split across an origin + plastic-linked
// sibling (Mastercard Internacional mixing COP+USD in one sheet).
//
// Validates upfront: every parsed row's currency must land on either origin
// or sibling; otherwise we throw a precise error the UI can translate.
export async function resolveReconcileDispatch(
  userId: number,
  origin: ReconcileDispatchAccount,
  parsed: Pick<ParsedStatement, "rows">,
): Promise<ReconcileDispatch> {
  const currenciesInFile = new Set<"COP" | "USD">();
  for (const row of parsed.rows) currenciesInFile.add(row.currency);

  if (currenciesInFile.size <= 1) {
    const only = currenciesInFile.values().next().value as "COP" | "USD" | undefined;
    if (only !== undefined && only !== origin.currency) {
      throw new Error(`currency_mismatch:file=${only},account=${origin.currency}`);
    }
    return { origin, sibling: null };
  }

  // Multi-currency xlsx — we need a plastic-linked sibling to absorb the
  // other-currency rows. Without one we reject (issue #444 acceptance: rows
  // must never land on an account whose currency doesn't match).
  if (!origin.physicalCardId) {
    throw new Error("multi_currency_without_physical_card");
  }
  const sibling = await loadReconcileSibling(userId, origin.physicalCardId, origin.id);
  if (!sibling) {
    // Name the error by the missing currency (COP or USD) so the UI can point
    // the user at exactly which sub-account is missing.
    const missing = [...currenciesInFile].find((c) => c !== origin.currency);
    throw new Error(`missing_${(missing ?? "usd").toLowerCase()}_sibling`);
  }
  if (sibling.institutionSlug !== origin.institutionSlug) {
    throw new Error(`sibling_institution_mismatch:${sibling.institutionSlug}`);
  }
  // Every parsed row must land on origin or sibling — guard against a 3rd
  // currency leaking in through a future parser change.
  for (const c of currenciesInFile) {
    if (c !== origin.currency && c !== sibling.currency) {
      throw new Error(`currency_not_in_plastic:${c}`);
    }
  }
  return { origin, sibling };
}
