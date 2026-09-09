import { describe, expect, it } from "vitest";
import type { RankedCandidate } from "@/lib/correlation/correlate";
import {
  citationFromEvidence,
  classifiableForRules,
  priorArtLookupRow,
  toAiClassifiable,
  type EvidenceReceipt,
  type TxEvidence,
} from "./evidence";

function candidate(id: number, rank: number): RankedCandidate {
  return {
    receiptId: id,
    rank,
    reason: { kind: "exact_amount", deltaCents: BigInt(0), deltaMs: 0 },
  };
}

function receipt(id: number, merchant: string): EvidenceReceipt {
  return {
    id,
    gateway: "mercado_pago",
    merchant,
    amountCents: BigInt(85_211_00),
    currency: "COP",
    referenceId: "400227",
    extra: { network: "redeban", last4: "2575" },
  };
}

function evidence(opts: { opaque: TxEvidence["opaque"]; receipts: EvidenceReceipt[] }): TxEvidence {
  const candidates = opts.receipts.map((r, i) => candidate(r.id, i + 1));
  return {
    candidates,
    receipts: new Map(opts.receipts.map((r) => [r.id, r])),
    unique: opts.receipts.length === 1,
    opaque: opts.opaque,
  };
}

describe("classifiableForRules", () => {
  const bankTx = {
    descriptionRaw: "MERCADOPAGO COLOMBIA",
    descriptionClean: "MERCADOPAGO COLOMBIA",
    merchant: "MERCADOPAGO COLOMBIA",
  };

  it("keys opaque unique rows on receipt.merchant, never the bank string", () => {
    const result = classifiableForRules(
      bankTx,
      evidence({ opaque: "mercado_pago", receipts: [receipt(10, "Almohada Ortopédica")] }),
    );
    expect(result.merchant).toBe("Almohada Ortopédica");
    expect(result.descriptionRaw).toBe("Almohada Ortopédica");
    expect(result.descriptionClean).toBeNull();
  });

  it("returns an empty haystack for opaque rows with no unique receipt", () => {
    const none = classifiableForRules(bankTx, evidence({ opaque: "mercado_pago", receipts: [] }));
    expect(none).toEqual({ descriptionRaw: "", descriptionClean: null, merchant: null });

    const ambiguous = classifiableForRules(
      bankTx,
      evidence({
        opaque: "mercado_pago",
        receipts: [receipt(10, "Almohada"), receipt(11, "Netflix")],
      }),
    );
    expect(ambiguous).toEqual({ descriptionRaw: "", descriptionClean: null, merchant: null });
  });

  it("leaves non-opaque rows on the bank description", () => {
    const tx = {
      descriptionRaw: "NETFLIX",
      descriptionClean: "Netflix",
      merchant: "NETFLIX",
    };
    expect(classifiableForRules(tx, evidence({ opaque: null, receipts: [] }))).toEqual(tx);
  });
});

describe("priorArtLookupRow", () => {
  it("does not key opaque rows on the bank merchant", () => {
    const row = {
      canonicalMerchant: "MERCADOPAGO COLOMBIA",
      merchant: "MERCADOPAGO COLOMBIA",
      descriptionRaw: "MERCADOPAGO COLOMBIA",
    };
    expect(priorArtLookupRow(row, evidence({ opaque: "mercado_pago", receipts: [] }))).toEqual({
      canonicalMerchant: null,
      merchant: null,
      descriptionRaw: "",
    });
    expect(
      priorArtLookupRow(
        row,
        evidence({ opaque: "mercado_pago", receipts: [receipt(10, "Almohada Ortopédica")] }),
      ),
    ).toEqual({
      canonicalMerchant: null,
      merchant: "Almohada Ortopédica",
      descriptionRaw: "Almohada Ortopédica",
    });
  });
});

describe("citationFromEvidence / toAiClassifiable", () => {
  it("cites receiptId only when the candidate set is unique", () => {
    const unique = evidence({
      opaque: "mercado_pago",
      receipts: [receipt(10, "Almohada Ortopédica")],
    });
    expect(citationFromEvidence(unique, { aiReason: "hogar" })).toMatchObject({
      receiptId: 10,
      matchKind: "exact_amount",
      aiReason: "hogar",
    });
    expect(citationFromEvidence(unique).receiptIds).toBeUndefined();
  });

  it("cites every receiptId when the set is ambiguous — never rank 1 alone", () => {
    const ambiguous = evidence({
      opaque: "mercado_pago",
      receipts: [receipt(10, "Almohada"), receipt(11, "Netflix")],
    });
    expect(citationFromEvidence(ambiguous)).toMatchObject({
      receiptIds: [10, 11],
      matchKind: "exact_amount",
    });
    expect(citationFromEvidence(ambiguous).receiptId).toBeUndefined();
  });

  it("puts receipt fields on the AI payload and never includes rawHtml", () => {
    const unique = evidence({
      opaque: "mercado_pago",
      receipts: [receipt(10, "Almohada Ortopédica")],
    });
    const payload = toAiClassifiable(
      {
        id: 972,
        descriptionRaw: "MERCADOPAGO COLOMBIA",
        amountCents: BigInt(-85_211_00),
        currency: "COP",
      },
      unique,
    );
    expect(payload.evidence).toEqual([
      expect.objectContaining({
        receiptId: 10,
        gateway: "mercado_pago",
        merchant: "Almohada Ortopédica",
        amountCents: "8521100",
        currency: "COP",
        referenceId: "400227",
        extra: { network: "redeban", last4: "2575" },
        matchKind: "exact_amount",
      }),
    ]);
    const serialized = JSON.stringify(payload.evidence);
    expect(serialized).not.toContain("rawHtml");
    expect(serialized).not.toContain("subject");
    expect(serialized).not.toContain("sender");
  });
});
