import { describe, expect, it } from "vitest";
import type { CorrelationReason, RankedCandidate } from "@/lib/correlation/correlate";
import {
  citationFromEvidence,
  classifiableForRules,
  priorArtLookupRow,
  toAiClassifiable,
  type EvidenceReceipt,
  type TxEvidence,
} from "./evidence";

function candidate(id: number, rank: number, reason?: CorrelationReason): RankedCandidate {
  return {
    receiptId: id,
    rank,
    reason: reason ?? { kind: "exact_amount", deltaCents: BigInt(0), deltaMs: 0 },
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

function evidence(opts: {
  opaque: TxEvidence["opaque"];
  receipts: EvidenceReceipt[];
  reason?: CorrelationReason;
}): TxEvidence {
  const candidates = opts.receipts.map((r, i) => candidate(r.id, i + 1, opts.reason));
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

  it("does not key opaque rows on a unique time-only receipt", () => {
    const result = classifiableForRules(
      bankTx,
      evidence({
        opaque: "mercado_pago",
        receipts: [receipt(10, "JetSmart")],
        reason: { kind: "time_only", deltaMs: 0 },
      }),
    );
    expect(result).toEqual({ descriptionRaw: "", descriptionClean: null, merchant: null });
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
    expect(
      priorArtLookupRow(
        row,
        evidence({
          opaque: "mercado_pago",
          receipts: [receipt(10, "JetSmart")],
          reason: { kind: "time_only", deltaMs: 0 },
        }),
      ),
    ).toEqual({
      canonicalMerchant: null,
      merchant: null,
      descriptionRaw: "",
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

  it("puts a unique time-only candidate on the AI bundle with null deltaCents", () => {
    const unique = evidence({
      opaque: "mercado_pago",
      receipts: [receipt(10, "JetSmart")],
      reason: { kind: "time_only", deltaMs: 12_000 },
    });
    const payload = toAiClassifiable(
      {
        id: 1443,
        descriptionRaw: "MERCADOPAGO COLOMBIA",
        amountCents: BigInt(-15_000_000),
        currency: "COP",
      },
      unique,
    );
    expect(payload.evidence).toEqual([
      expect.objectContaining({
        receiptId: 10,
        merchant: "JetSmart",
        matchKind: "time_only",
        deltaCents: null,
        deltaMs: 12_000,
      }),
    ]);
    expect(citationFromEvidence(unique)).toMatchObject({
      receiptId: 10,
      matchKind: "time_only",
    });
  });
});
