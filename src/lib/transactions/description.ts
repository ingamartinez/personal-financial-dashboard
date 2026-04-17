export type DescribedTx = {
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  counterparty: { displayName: string } | null;
};

export function primaryDescription(tx: DescribedTx): string {
  return tx.counterparty?.displayName ?? tx.merchant ?? tx.descriptionClean ?? tx.descriptionRaw;
}

export function hasSecondaryDescription(tx: DescribedTx): boolean {
  return Boolean(tx.counterparty || tx.merchant || tx.descriptionClean);
}
