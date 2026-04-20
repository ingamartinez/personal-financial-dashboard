import { describe, expect, it } from "vitest";
import type { AccountDetail } from "@/lib/accounts/queries";
import type { OcrParsedRow } from "@/lib/ingestion/ocr";
import { buildDraftFromOcrRow } from "./ocr-draft";

const ACCOUNT: AccountDetail = {
  id: 7,
  name: "ARQ",
  institution: "ARQ",
  type: "savings",
  currency: "USD",
  balanceCents: BigInt(0),
  active: true,
  metadata: {},
  physicalCardId: null,
  physicalCard: null,
};

function row(overrides: Partial<OcrParsedRow> = {}): OcrParsedRow {
  return {
    rowIndex: 0,
    occurredOn: "2026-04-15",
    description: "COFFEE SHOP",
    amountCents: BigInt(-325),
    externalId: "ocr:7:abc123",
    ...overrides,
  };
}

describe("buildDraftFromOcrRow", () => {
  it("maps a negative amount to an expense with absolute value", () => {
    const result = buildDraftFromOcrRow(row({ amountCents: BigInt(-325) }), ACCOUNT);
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.amountCents).toBe("325");
    expect(result.draft.currency).toBe("USD");
    expect(result.draft.accountId).toBe(7);
  });

  it("maps a positive amount to income", () => {
    const result = buildDraftFromOcrRow(row({ amountCents: BigInt(50000) }), ACCOUNT);
    expect(result.draft.direction).toBe("income");
    expect(result.draft.amountCents).toBe("50000");
  });

  it("preserves description as both merchant and description", () => {
    const result = buildDraftFromOcrRow(row({ description: "PAYU*CINEMARK" }), ACCOUNT);
    expect(result.draft.merchant).toBe("PAYU*CINEMARK");
    expect(result.draft.description).toBe("PAYU*CINEMARK");
  });

  it("uses the account's currency (OCR doesn't know currency)", () => {
    const copAcc: AccountDetail = { ...ACCOUNT, id: 2, currency: "COP" };
    const result = buildDraftFromOcrRow(row(), copAcc);
    expect(result.draft.currency).toBe("COP");
  });

  it("passes occurredOn through unchanged", () => {
    const result = buildDraftFromOcrRow(row({ occurredOn: "2026-03-02" }), ACCOUNT);
    expect(result.draft.occurredOn).toBe("2026-03-02");
  });

  it("preserves externalId for dedup against OCR-via-import path", () => {
    const result = buildDraftFromOcrRow(row({ externalId: "ocr:7:deadbeef" }), ACCOUNT);
    expect(result.externalId).toBe("ocr:7:deadbeef");
  });
});
