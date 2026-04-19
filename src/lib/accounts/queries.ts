import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import type { AccountType, Currency } from "@/lib/types";

export type AccountDetail = {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  balanceCents: bigint;
  active: boolean;
  metadata: AccountMetadata;
};

export async function listAccountsDetailed(userId: number): Promise<AccountDetail[]> {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: accounts.balanceCents,
      active: accounts.active,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)))
    .orderBy(asc(accounts.type), asc(accounts.institution), asc(accounts.name));
}
