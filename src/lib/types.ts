import {
  accountType,
  classificationMethod,
  counterpartyKeyKind,
  counterpartyType,
  currency,
  txSource,
} from "@/lib/db/schema";

// Enum types derived from Drizzle `pgEnum` definitions. Adding a variant in
// schema.ts is the only place needed — every consumer picks it up via these
// aliases. Never redeclare these as inline unions.
export type AccountType = (typeof accountType.enumValues)[number];
export type Currency = (typeof currency.enumValues)[number];
export type TransactionSource = (typeof txSource.enumValues)[number];
export type ClassificationMethod = (typeof classificationMethod.enumValues)[number];
export type CounterpartyType = (typeof counterpartyType.enumValues)[number];
export type CounterpartyKind = (typeof counterpartyKeyKind.enumValues)[number];

export type CounterpartyAlias = {
  id: number;
  kind: CounterpartyKind;
  value: string;
};

export type CounterpartyBrief = {
  id: number;
  displayName: string;
  type: CounterpartyType;
};

export type CounterpartyValue = {
  id: number;
  displayName: string;
  type: CounterpartyType;
  defaultCategorySlug: string | null;
  notes: string | null;
  aliases: CounterpartyAlias[];
};

export type TxRow = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  categorySlug: string | null;
  classificationMethod: ClassificationMethod;
  classificationConfidence: number | null;
  source: TransactionSource;
  isAdjustment: boolean;
  accountId: number;
  accountName: string;
  // #406: account type surfaces in the table so the row-actions menu can
  // gate the "Editar cuotas" option to TC rows only.
  accountType: AccountType;
  // #406: installment fields. `installmentRateBps` is null when the tx
  // inherits from the account's bucket (see rates.resolveBucketRateBps).
  installmentsTotal: number;
  installmentRateBps: number | null;
  counterparty: CounterpartyValue | null;
  deletedAt: Date | null;
};
