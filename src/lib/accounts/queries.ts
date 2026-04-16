import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, type AccountMetadata } from "@/lib/db/schema";

export type AccountDetail = {
  id: number;
  name: string;
  institution: string;
  type: "savings" | "credit_card" | "loan";
  currency: "COP" | "USD";
  balanceCents: bigint;
  active: boolean;
  metadata: AccountMetadata;
};

export async function listAccountsDetailed(): Promise<AccountDetail[]> {
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
    .orderBy(asc(accounts.type), asc(accounts.institution), asc(accounts.name));
}
