import { describe, expect, it } from "vitest";
import type { AccountDetail } from "@/lib/accounts/queries";
import { parseSmsBancolombia, type ParsedSms } from "@/lib/ingestion/sms-bancolombia";
import { buildDraftFromParsedSms } from "./sms-draft";

const ACCOUNTS: AccountDetail[] = [
  {
    id: 1,
    name: "Ahorros",
    institution: "Bancolombia",
    type: "savings",
    currency: "COP",
    balanceCents: BigInt(0),
    active: true,
    metadata: { last4s: ["1234"] },
    physicalCardId: null,
    physicalCard: null,
  },
  {
    id: 2,
    name: "Visa",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    balanceCents: BigInt(0),
    active: true,
    metadata: { last4s: ["2575"] },
    physicalCardId: null,
    physicalCard: null,
  },
  {
    id: 3,
    name: "Visa USD",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "USD",
    balanceCents: BigInt(0),
    active: true,
    metadata: { last4s: ["2575"] },
    physicalCardId: null,
    physicalCard: null,
  },
  {
    id: 4,
    name: "Inactive",
    institution: "Bancolombia",
    type: "savings",
    currency: "COP",
    balanceCents: BigInt(0),
    active: false,
    metadata: { last4s: ["9999"] },
    physicalCardId: null,
    physicalCard: null,
  },
];

function parseOrThrow(body: string): ParsedSms {
  const parsed = parseSmsBancolombia(body);
  if (parsed.kind === "skip" || parsed.kind === "needs_review") {
    throw new Error(`expected parse, got ${parsed.kind}: ${parsed.reason}`);
  }
  return parsed;
}

describe("buildDraftFromParsedSms", () => {
  it("maps a purchase to an expense draft with merchant and resolved account", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Compraste $45.000,00 en RAPPI con tu T.Cred *2575, el 15/04/2026 a las 19:30",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.currency).toBe("COP");
    expect(result.draft.amountCents).toBe("4500000");
    expect(result.draft.merchant).toBe("RAPPI");
    expect(result.draft.description).toBe("RAPPI");
    expect(result.draft.accountId).toBe(2);
    expect(result.draft.occurredOn).toBe("2026-04-15");
    expect(result.draft.categorySlug).toBeUndefined();
    expect(result.externalId).toBe(parsed.externalId);
    expect(result.externalId.startsWith("bcol-sms:")).toBe(true);
  });

  it("routes a USD purchase to the USD account when same last4 exists in two currencies", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Compraste USD195,26 en AMAZON con tu T.Cred *2575, el 15/04/2026 a las 19:30",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.currency).toBe("USD");
    expect(result.draft.accountId).toBe(3);
  });

  it("leaves accountId undefined when no account matches the last4", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Compraste $10.000,00 en FOO con tu T.Cred *9876, el 15/04/2026 a las 19:30",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.accountId).toBeUndefined();
    expect(result.draft.direction).toBe("expense");
  });

  it("ignores inactive accounts when resolving by last4", () => {
    // last4 '9999' matches an INACTIVE account — should not resolve.
    const parsed = parseOrThrow(
      "Bancolombia: Compraste $10.000,00 en FOO con tu T.Cred *9999, el 15/04/2026 a las 19:30",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.accountId).toBeUndefined();
  });

  it("maps a transfer_sent to expense with 'transferencias' category", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Transferiste $100.000,00 desde tu cuenta *1234 a la cuenta *9988, el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.categorySlug).toBe("transferencias");
    expect(result.draft.accountId).toBe(1);
    expect(result.draft.description).toContain("*9988");
  });

  it("maps a QR transfer with isQR=true", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Transferiste $50.000,00 por QR desde tu cuenta *1234 a la cuenta *5566, el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.description).toContain("QR");
  });

  it("maps a transfer_received to income with 'ingresos' category", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Alejandro, recibiste una transferencia de PEPITO PEREZ por $200.000,00 en tu cuenta *1234 conectada a la llave 3150 el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("income");
    expect(result.draft.categorySlug).toBe("ingresos");
    expect(result.draft.merchant).toBe("PEPITO PEREZ");
    expect(result.draft.accountId).toBe(1);
  });

  it("maps tc_payment to a transfer group draft (savings → TC) with no category (#405)", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Pagaste $500.000,00 en la tarjeta de credito *2575 desde la cuenta *1234, el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("expense");
    // #405: transfers don't carry a spend/income category.
    expect(result.draft.categorySlug).toBeUndefined();
    // Origin is the savings account matched by fromLast4.
    expect(result.draft.accountId).toBe(1);
    // Destination TC is resolved from toCardLast4 + currency.
    expect(result.draft.transfer).toEqual({ destinationAccountId: 2 });
  });

  it("tc_payment leaves destination undefined when the TC isn't in findash", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Pagaste $500.000,00 en la tarjeta de credito *7777 desde la cuenta *1234, el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.transfer).toEqual({ destinationAccountId: undefined });
  });

  it("tc_credit_received produces an unpaired transfer-leg draft (#405)", () => {
    const parsed = parseOrThrow(
      "Bancolombia: AIDA MALDONADO hizo un abono por $2,125,092 a tu tarjeta de credito terminada en **2575, el 03/12/2025 13:40. Si tienes dudas, llamanos al 018000931987. Estamos cerca.",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.categorySlug).toBeUndefined();
    // Empty transfer marker → confirm will insert a single leg with
    // channel="transfer" and transfer_group_id=null (origin is external).
    expect(result.draft.transfer).toEqual({});
    expect(result.draft.accountId).toBe(2);
  });

  it("maps atm_withdrawal with resolved account but no category", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Retiraste $100.000,00 en 43AVENIDA de tu T.Deb *1234 el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.accountId).toBe(1);
    expect(result.draft.categorySlug).toBeUndefined();
    expect(result.draft.description).toContain("43AVENIDA");
  });

  it("maps qr_payment to expense without category (rule engine handles it)", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Alejandro pagaste $30.000,00 por codigo QR desde tu cuenta *1234 a la llave 3150 el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("expense");
    expect(result.draft.accountId).toBe(1);
    expect(result.draft.categorySlug).toBeUndefined();
    expect(result.draft.description).toContain("llave 3150");
  });

  it("routes provider_payment to the Bancolombia savings account of matching currency", () => {
    const parsed = parseOrThrow(
      "Bancolombia: Recibiste un pago PROVEEDOR de EMPRESA XYZ por $1.000.000,00 en tu cuenta de Ahorros el 15/04/2026 a las 10:00",
    );
    const result = buildDraftFromParsedSms(parsed, ACCOUNTS);
    expect(result.draft.direction).toBe("income");
    expect(result.draft.accountId).toBe(1);
    expect(result.draft.categorySlug).toBe("ingresos");
  });

  it("preserves externalId so SMS-forward dedupes against regular SMS ingest", () => {
    const body =
      "Bancolombia: Compraste $45.000,00 en RAPPI con tu T.Cred *2575, el 15/04/2026 a las 19:30";
    const fromTelegram = buildDraftFromParsedSms(parseOrThrow(body), ACCOUNTS).externalId;
    const fromPhoneIngest = parseOrThrow(body).externalId;
    expect(fromTelegram).toBe(fromPhoneIngest);
  });
});
