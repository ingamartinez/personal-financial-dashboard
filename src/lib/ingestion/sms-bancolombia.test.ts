import { describe, expect, it } from "vitest";
import {
  parseSmsAmount,
  parseSmsBancolombia,
  parseSmsDate,
  resolveAccountFromLast4,
  type RoutableAccount,
} from "./sms-bancolombia";

describe("parseSmsAmount", () => {
  it("parses EU format with COP prefix", () => {
    expect(parseSmsAmount("COP35.450,00")).toEqual({
      cents: BigInt(3545000),
      currency: "COP",
    });
  });

  it("parses EU format with USD prefix", () => {
    expect(parseSmsAmount("USD195,26")).toEqual({
      cents: BigInt(19526),
      currency: "USD",
    });
    expect(parseSmsAmount("USD10,00")).toEqual({
      cents: BigInt(1000),
      currency: "USD",
    });
  });

  it("parses EU format with $ prefix (the failed SMS case)", () => {
    expect(parseSmsAmount("$92.000,00")).toEqual({
      cents: BigInt(9200000),
      currency: "COP",
    });
  });

  it("parses US format with $ prefix and 2 decimals", () => {
    expect(parseSmsAmount("$30,000.00")).toEqual({
      cents: BigInt(3000000),
      currency: "COP",
    });
    expect(parseSmsAmount("$6,000,000.00")).toEqual({
      cents: BigInt(600000000),
      currency: "COP",
    });
  });

  it("parses US format with $ prefix and no decimals", () => {
    expect(parseSmsAmount("$56,000")).toEqual({
      cents: BigInt(5600000),
      currency: "COP",
    });
    expect(parseSmsAmount("$1,320,564")).toEqual({
      cents: BigInt(132056400),
      currency: "COP",
    });
    expect(parseSmsAmount("$92,000.00")).toEqual({
      cents: BigInt(9200000),
      currency: "COP",
    });
  });

  it("throws on invalid input", () => {
    expect(() => parseSmsAmount("not a number")).toThrow();
    expect(() => parseSmsAmount("abc123")).toThrow();
  });
});

describe("parseSmsDate", () => {
  it("parses DD/MM/YYYY", () => {
    expect(parseSmsDate("15/04/2026")).toBe("2026-04-15");
  });
  it("parses DD/MM/YY", () => {
    expect(parseSmsDate("14/04/26")).toBe("2026-04-14");
  });
  it("parses YYYY/MM/DD", () => {
    expect(parseSmsDate("2026/04/12")).toBe("2026-04-12");
  });
  it("throws on bad format", () => {
    expect(() => parseSmsDate("04-15-2026")).toThrow();
    expect(() => parseSmsDate("15/13/2026")).toThrow();
  });
});

describe("parseSmsBancolombia — purchase (variant A: 'con tu T.{Cred|Deb}')", () => {
  it("parses COP credit purchase", () => {
    const body =
      "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(3545000));
    expect(r.currency).toBe("COP");
    expect(r.merchant).toBe("DLO*DiDi Food CO Pay");
    expect(r.cardLast4).toBe("2575");
    expect(r.cardKind).toBe("credit");
    expect(r.occurredOn).toBe("2026-04-15");
    expect(r.occurredTime).toBe("20:34");
    expect(r.externalId).toMatch(/^bcol-sms:[a-f0-9]{24}$/);
  });

  it("parses USD credit purchase", () => {
    const body =
      "Bancolombia: Compraste USD10,00 en ANTHROPIC con tu T.Cred *7291, el 15/04/2026 a las 02:58. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(1000));
    expect(r.currency).toBe("USD");
    expect(r.merchant).toBe("ANTHROPIC");
    expect(r.cardLast4).toBe("7291");
    expect(r.cardKind).toBe("credit");
  });

  it("parses merchant with spaces and special chars", () => {
    const body =
      "Bancolombia: Compraste COP217.029,00 en DROGUERIA CRUZ VERDE con tu T.Cred *2575, el 12/04/2026 a las 17:00. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.merchant).toBe("DROGUERIA CRUZ VERDE");
    expect(r.amountCents).toBe(BigInt(21702900));
    expect(r.cardKind).toBe("credit");
  });

  it("parses COP debit purchase (the #73 bug fix)", () => {
    const body =
      "Bancolombia: Compraste $23.900,00 en EXPERIAN COLOMBIA con tu T.Deb *1802, el 16/04/2026 a las 06:30. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(2390000));
    expect(r.currency).toBe("COP");
    expect(r.merchant).toBe("EXPERIAN COLOMBIA");
    expect(r.cardLast4).toBe("1802");
    expect(r.cardKind).toBe("debit");
    expect(r.occurredOn).toBe("2026-04-16");
    expect(r.occurredTime).toBe("06:30");
  });
});

describe("parseSmsBancolombia — purchase (variant B: 'Esta compra esta asociada')", () => {
  it("parses COP credit purchase with alternate phrasing", () => {
    const body =
      "Bancolombia: Compraste COP71.950,00 en RAPPI COLOMBIA*DL, el 15/04/2026 a las 12:50. Esta compra esta asociada a T.Cred *2575. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(7195000));
    expect(r.currency).toBe("COP");
    expect(r.merchant).toBe("RAPPI COLOMBIA*DL");
    expect(r.cardLast4).toBe("2575");
    expect(r.cardKind).toBe("credit");
  });

  it("parses USD credit purchase with alternate phrasing", () => {
    const body =
      "Bancolombia: Compraste USD195,26 en CLAUDE.AI SUBSCRIPTI, el 15/04/2026 a las 01:09. Esta compra esta asociada a T.Cred *7291. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(19526));
    expect(r.currency).toBe("USD");
    expect(r.merchant).toBe("CLAUDE.AI SUBSCRIPTI");
    expect(r.cardLast4).toBe("7291");
    expect(r.cardKind).toBe("credit");
  });

  it("parses COP debit purchase with alternate phrasing", () => {
    const body =
      "Bancolombia: Compraste $48.500,00 en SUPERMERCADO LA 14, el 14/04/2026 a las 11:22. Esta compra esta asociada a T.Deb *1802. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(4850000));
    expect(r.merchant).toBe("SUPERMERCADO LA 14");
    expect(r.cardLast4).toBe("1802");
    expect(r.cardKind).toBe("debit");
  });
});

describe("parseSmsBancolombia — purchase (variant C: reversed 'el TIME a las DATE')", () => {
  it("parses USD credit purchase with reversed time/date (the #77 bug fix)", () => {
    const body =
      "Bancolombia: Compraste USD10,00 en GITHUB, INC., el 14:02 a las 05/12/2025. Esta compra esta asociada a T.Cred *7291. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(1000));
    expect(r.currency).toBe("USD");
    expect(r.merchant).toBe("GITHUB, INC.");
    expect(r.cardLast4).toBe("7291");
    expect(r.cardKind).toBe("credit");
    expect(r.occurredOn).toBe("2025-12-05");
    expect(r.occurredTime).toBe("14:02");
  });

  it("parses additional reversed-order samples from the historical dump", () => {
    const samples = [
      {
        body: "Bancolombia: Compraste COP65.000,00 en FC* FREEPIK PREMIUM, el 20:15 a las 07/12/2025. Esta compra esta asociada a T.Cred *2575. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.",
        cents: BigInt(6500000),
        currency: "COP",
        merchant: "FC* FREEPIK PREMIUM",
        last4: "2575",
        date: "2025-12-07",
        time: "20:15",
      },
      {
        body: "Bancolombia: Compraste USD149,00 en WWW.SPLASHTOP.COM, el 10:46 a las 17/02/2026. Esta compra esta asociada a T.Cred *7291. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.",
        cents: BigInt(14900),
        currency: "USD",
        merchant: "WWW.SPLASHTOP.COM",
        last4: "7291",
        date: "2026-02-17",
        time: "10:46",
      },
      {
        body: "Bancolombia: Compraste COP91.550,00 en RAPPI COLOMBIA*DL, el 13:44 a las 28/12/2025. Esta compra esta asociada a T.Cred *2575. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.",
        cents: BigInt(9155000),
        currency: "COP",
        merchant: "RAPPI COLOMBIA*DL",
        last4: "2575",
        date: "2025-12-28",
        time: "13:44",
      },
    ] as const;

    for (const s of samples) {
      const r = parseSmsBancolombia(s.body);
      expect(r.kind).toBe("purchase");
      if (r.kind !== "purchase") throw new Error("type guard");
      expect(r.amountCents).toBe(s.cents);
      expect(r.currency).toBe(s.currency);
      expect(r.merchant).toBe(s.merchant);
      expect(r.cardLast4).toBe(s.last4);
      expect(r.cardKind).toBe("credit");
      expect(r.occurredOn).toBe(s.date);
      expect(r.occurredTime).toBe(s.time);
    }
  });

  it("parses debit purchase with reversed time/date", () => {
    const body =
      "Bancolombia: Compraste $35.000,00 en TIENDA D1, el 09:12 a las 03/02/2026. Esta compra esta asociada a T.Deb *1802. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("purchase");
    if (r.kind !== "purchase") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(3500000));
    expect(r.merchant).toBe("TIENDA D1");
    expect(r.cardLast4).toBe("1802");
    expect(r.cardKind).toBe("debit");
    expect(r.occurredOn).toBe("2026-02-03");
    expect(r.occurredTime).toBe("09:12");
  });
});

describe("parseSmsBancolombia — transfer sent", () => {
  it("parses standard transfer (US amount format, no QR)", () => {
    const body =
      "Bancolombia: Transferiste $30,000.00 desde tu cuenta 6126 a la cuenta *3137898857 el 15/04/2026 a las 15:01. ¿Dudas? Llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_sent");
    if (r.kind !== "transfer_sent") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(3000000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toAccount).toBe("3137898857");
    expect(r.isQR).toBe(false);
    expect(r.occurredOn).toBe("2026-04-15");
    expect(r.occurredTime).toBe("15:01");
  });

  it("parses QR transfer (alt date format YYYY/MM/DD, inline time)", () => {
    const body =
      "Bancolombia: Transferiste $25,000.00 por QR desde tu cuenta 6126 a la cuenta 8750, el 2026/04/12 18:07. ¿Dudas? Llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_sent");
    if (r.kind !== "transfer_sent") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(2500000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toAccount).toBe("8750");
    expect(r.isQR).toBe(true);
    expect(r.occurredOn).toBe("2026-04-12");
    expect(r.occurredTime).toBe("18:07");
  });

  it("parses transfer without decimals in amount", () => {
    const body =
      "Bancolombia: Transferiste $56,000 desde tu cuenta *6126 a la cuenta *00532723035 el 13/04/2026 a las 18:41. ¿Dudas? Llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_sent");
    if (r.kind !== "transfer_sent") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(5600000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toAccount).toBe("00532723035");
  });
});

describe("parseSmsBancolombia — bre_b_transfer (named recipient + key)", () => {
  it("parses real Bre-b sample from the historical dump", () => {
    const body =
      "Bancolombia: ALEJANDRO, transferiste $50,000.00 a la llave 3046262677 desde tu cuenta *6126 a MARIA PAZ TORRES CARRILLO el 01/04/26 a las 13:22. Con Bre-b es de una y gratis. Dudas al 018000912345.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("bre_b_transfer");
    if (r.kind !== "bre_b_transfer") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(5000000));
    expect(r.currency).toBe("COP");
    expect(r.fromLast4).toBe("6126");
    expect(r.toKey).toBe("3046262677");
    expect(r.recipientName).toBe("MARIA PAZ TORRES CARRILLO");
    expect(r.occurredOn).toBe("2026-04-01");
    expect(r.occurredTime).toBe("13:22");
    expect(r.externalId).toMatch(/^bcol-sms:[a-f0-9]{24}$/);
  });

  it("parses Bre-b with single-word recipient", () => {
    const body =
      "Bancolombia: ALEJANDRO, transferiste $25,000.00 a la llave 3001112233 desde tu cuenta *6126 a JUAN el 02/04/2026 a las 09:10. Con Bre-b es de una y gratis. Dudas al 018000912345.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("bre_b_transfer");
    if (r.kind !== "bre_b_transfer") throw new Error("type guard");
    expect(r.recipientName).toBe("JUAN");
    expect(r.toKey).toBe("3001112233");
  });

  it("does NOT regress regular transfer_sent (which has no 'a la llave' segment)", () => {
    const body =
      "Bancolombia: Transferiste $30,000.00 desde tu cuenta 6126 a la cuenta *3137898857 el 15/04/2026 a las 15:01. ¿Dudas? Llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_sent");
  });
});

describe("parseSmsBancolombia — QR payment", () => {
  it("parses QR payment with name prefix", () => {
    const body =
      "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste $92,000.00 por codigo QR desde tu cuenta *6126 a la llave 0091498581 el 15/04/2026 a las 00:20. Con codigo QR es facil y de una. Dudas al 018000912345";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("qr_payment");
    if (r.kind !== "qr_payment") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(9200000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toKey).toBe("0091498581");
    expect(r.occurredOn).toBe("2026-04-15");
    expect(r.occurredTime).toBe("00:20");
  });

  it("parses different QR payment amounts", () => {
    const samples = [
      ["$50,000.00", BigInt(5000000), "0088044474", "14/04/2026", "13:40"],
      ["$130,000.00", BigInt(13000000), "0042457234", "14/04/2026", "16:48"],
      ["$13,000.00", BigInt(1300000), "0087114069", "14/04/2026", "18:09"],
    ] as const;
    for (const [amt, cents, key, date, time] of samples) {
      const body = `Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste ${amt} por codigo QR desde tu cuenta *6126 a la llave ${key} el ${date} a las ${time}. Con codigo QR es facil y de una. Dudas al 018000912345`;
      const r = parseSmsBancolombia(body);
      expect(r.kind).toBe("qr_payment");
      if (r.kind !== "qr_payment") throw new Error("type guard");
      expect(r.amountCents).toBe(cents);
      expect(r.toKey).toBe(key);
    }
  });
});

describe("parseSmsBancolombia — TC payment", () => {
  it("parses payment to credit card from savings", () => {
    const body =
      "Bancolombia: Pagaste $1,320,564 en la tarjeta de credito *7291 desde la cuenta *6126, el 14/04/2026 21:48. ¿Dudas? Llamanos al 018000912345. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("tc_payment");
    if (r.kind !== "tc_payment") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(132056400));
    expect(r.fromLast4).toBe("6126");
    expect(r.toCardLast4).toBe("7291");
    expect(r.occurredOn).toBe("2026-04-14");
    expect(r.occurredTime).toBe("21:48");
  });

  it("parses payment to a different credit card", () => {
    const body =
      "Bancolombia: Pagaste $4,351,431 en la tarjeta de credito *2575 desde la cuenta *6126, el 14/04/2026 21:47. ¿Dudas? Llamanos al 018000912345. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("tc_payment");
    if (r.kind !== "tc_payment") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(435143100));
    expect(r.toCardLast4).toBe("2575");
  });
});

describe("parseSmsBancolombia — transfer received", () => {
  it("parses variant A: 'ALEJANDRO, recibiste una transferencia de SENDER'", () => {
    const body =
      "Bancolombia: ALEJANDRO, recibiste una transferencia de ESTEBAN LEONARDO SARMIENTO GOMEZ por $100,000.00 en tu cuenta *6126 conectada a la llave 3012998429 el 14/04/26 a las 15:28. Con llaves es de una y gratis. Dudas al 018000912345";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_received");
    if (r.kind !== "transfer_received") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(10000000));
    expect(r.senderName).toBe("ESTEBAN LEONARDO SARMIENTO GOMEZ");
    expect(r.toLast4).toBe("6126");
    expect(r.occurredOn).toBe("2026-04-14");
    expect(r.occurredTime).toBe("15:28");
  });

  it("parses variant B: 'Recibiste una transferencia por AMOUNT de SENDER' with **NNNN", () => {
    const body =
      "Bancolombia: Recibiste una transferencia por $56,000 de MAURICIO JURADO en tu cuenta **6126, el 12/04/2026 a las 17:10. Si tienes dudas, hablemos: 018000931987. Siempre a tu lado.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("transfer_received");
    if (r.kind !== "transfer_received") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(5600000));
    expect(r.senderName).toBe("MAURICIO JURADO");
    expect(r.toLast4).toBe("6126");
  });
});

describe("parseSmsBancolombia — provider_payment_sent (PSE / bill-pay)", () => {
  it("parses utility payment with HH:MM:SS time", () => {
    const body =
      "Bancolombia: Pagaste $430,997.00 a EMPRESAS PUBLICAS DE MEDELLIN desde tu producto *6126 el 13/02/2026 10:39:06. ¿Dudas? Llamanos al 6045109095. Estamos cerca";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("provider_payment_sent");
    if (r.kind !== "provider_payment_sent") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(43099700));
    expect(r.currency).toBe("COP");
    expect(r.providerName).toBe("EMPRESAS PUBLICAS DE MEDELLIN");
    expect(r.fromLast4).toBe("6126");
    expect(r.occurredOn).toBe("2026-02-13");
    expect(r.occurredTime).toBe("10:39"); // seconds dropped
    expect(r.externalId).toMatch(/^bcol-sms:[a-f0-9]{24}$/);
  });

  it("parses additional PSE samples from the historical dump", () => {
    const samples = [
      {
        body: "Bancolombia: Pagaste $1,839,400.00 a Arrendamientos Santa Fe EU desde tu producto *6126 el 02/01/2026 19:54:20. ¿Dudas? Llamanos al 6045109095. Estamos cerca",
        cents: BigInt(183940000),
        provider: "Arrendamientos Santa Fe EU",
        date: "2026-01-02",
        time: "19:54",
      },
      {
        body: "Bancolombia: Pagaste $413,300.00 a APORTES EN LINEA desde tu producto *6126 el 02/01/2026 19:59:18. ¿Dudas? Llamanos al 6045109095. Estamos cerca",
        cents: BigInt(41330000),
        provider: "APORTES EN LINEA",
        date: "2026-01-02",
        time: "19:59",
      },
      {
        body: "Bancolombia: Pagaste $71,090.00 a BANCO FALABELLA S A desde tu producto *6126 el 02/01/2026 20:06:46. ¿Dudas? Llamanos al 6045109095. Estamos cerca",
        cents: BigInt(7109000),
        provider: "BANCO FALABELLA S A",
        date: "2026-01-02",
        time: "20:06",
      },
      {
        body: "Bancolombia: Pagaste $1,350,000.00 a FIDEICOMISO P.A. PLAN ROMBO desde tu producto *6126 el 14/01/2026 19:54:39. ¿Dudas? Llamanos al 6045109095. Estamos cerca",
        cents: BigInt(135000000),
        provider: "FIDEICOMISO P.A. PLAN ROMBO",
        date: "2026-01-14",
        time: "19:54",
      },
    ] as const;

    for (const s of samples) {
      const r = parseSmsBancolombia(s.body);
      expect(r.kind).toBe("provider_payment_sent");
      if (r.kind !== "provider_payment_sent") throw new Error("type guard");
      expect(r.amountCents).toBe(s.cents);
      expect(r.providerName).toBe(s.provider);
      expect(r.fromLast4).toBe("6126");
      expect(r.occurredOn).toBe(s.date);
      expect(r.occurredTime).toBe(s.time);
    }
  });

  it("parses PSE without seconds in time", () => {
    const body =
      "Bancolombia: Pagaste $50,000.00 a EPM desde tu producto *6126 el 10/02/2026 14:30. ¿Dudas? Llamanos al 6045109095. Estamos cerca";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("provider_payment_sent");
    if (r.kind !== "provider_payment_sent") throw new Error("type guard");
    expect(r.providerName).toBe("EPM");
    expect(r.occurredTime).toBe("14:30");
  });
});

describe("parseSmsBancolombia — atm_withdrawal", () => {
  it("parses ATM withdrawal with alphanumeric code", () => {
    const body =
      "Bancolombia: Retiraste $100.000,00 en 43AVENIDA de tu T.Deb **1802 el 19/02/2026 a las 16:36. Si tienes dudas, llamanos al 6045109095. Estamos cerca";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("atm_withdrawal");
    if (r.kind !== "atm_withdrawal") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(10000000));
    expect(r.currency).toBe("COP");
    expect(r.atmCode).toBe("43AVENIDA");
    expect(r.fromLast4).toBe("1802");
    expect(r.occurredOn).toBe("2026-02-19");
    expect(r.occurredTime).toBe("16:36");
    expect(r.externalId).toMatch(/^bcol-sms:[a-f0-9]{24}$/);
  });

  it("parses ATM withdrawal with code containing underscore", () => {
    const body =
      "Bancolombia: Retiraste $100.000,00 en PQ_ESTRELL1 de tu T.Deb **1802 el 26/02/2026 a las 20:47. Si tienes dudas, llamanos al 6045109095. Estamos cerca";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("atm_withdrawal");
    if (r.kind !== "atm_withdrawal") throw new Error("type guard");
    expect(r.atmCode).toBe("PQ_ESTRELL1");
    expect(r.fromLast4).toBe("1802");
  });

  it("parses ATM withdrawal with single-asterisk last4", () => {
    const body =
      "Bancolombia: Retiraste $200.000,00 en CC_OVIEDO de tu T.Deb *1802 el 03/03/2026 a las 11:15. Si tienes dudas, llamanos al 6045109095. Estamos cerca";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("atm_withdrawal");
    if (r.kind !== "atm_withdrawal") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(20000000));
    expect(r.atmCode).toBe("CC_OVIEDO");
  });
});

describe("parseSmsBancolombia — tc_credit_received (third-party abono to my TC)", () => {
  it("parses abono to TC *2575", () => {
    const body =
      "Bancolombia: AIDA MALDONADO hizo un abono por $2,125,092 a tu tarjeta de credito terminada en **2575, el 03/12/2025 13:40. Si tienes dudas, llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("tc_credit_received");
    if (r.kind !== "tc_credit_received") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(212509200));
    expect(r.currency).toBe("COP");
    expect(r.senderName).toBe("AIDA MALDONADO");
    expect(r.toCardLast4).toBe("2575");
    expect(r.occurredOn).toBe("2025-12-03");
    expect(r.occurredTime).toBe("13:40");
    expect(r.externalId).toMatch(/^bcol-sms:[a-f0-9]{24}$/);
  });

  it("parses abono to a different TC (*7291) by the same sender", () => {
    const body =
      "Bancolombia: AIDA MALDONADO hizo un abono por $446,666 a tu tarjeta de credito terminada en **7291, el 03/12/2025 13:42. Si tienes dudas, llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("tc_credit_received");
    if (r.kind !== "tc_credit_received") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(44666600));
    expect(r.senderName).toBe("AIDA MALDONADO");
    expect(r.toCardLast4).toBe("7291");
  });

  it("parses abono with multi-word sender", () => {
    const body =
      "Bancolombia: JOSE LUIS PEREZ GARCIA hizo un abono por $352,712 a tu tarjeta de credito terminada en **2575, el 13/12/2025 14:24. Si tienes dudas, llamanos al 018000931987. Estamos cerca.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("tc_credit_received");
    if (r.kind !== "tc_credit_received") throw new Error("type guard");
    expect(r.senderName).toBe("JOSE LUIS PEREZ GARCIA");
    expect(r.toCardLast4).toBe("2575");
    expect(r.amountCents).toBe(BigInt(35271200));
  });
});

describe("parseSmsBancolombia — provider payment", () => {
  it("parses provider payment to Ahorros", () => {
    const body =
      "Bancolombia: Recibiste un pago PROVEEDOR de PEXTO COLOMBIA por $6,000,000.00 en tu cuenta de Ahorros el 14/04/2026 a las 21:43. Si tienes dudas, llamanos al 018000931987. A tu lado siempre.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("provider_payment");
    if (r.kind !== "provider_payment") throw new Error("type guard");
    expect(r.amountCents).toBe(BigInt(600000000));
    expect(r.senderName).toBe("PEXTO COLOMBIA");
    expect(r.occurredOn).toBe("2026-04-14");
    expect(r.occurredTime).toBe("21:43");
  });
});

describe("parseSmsBancolombia — skip reasons", () => {
  it("skips failed purchases", () => {
    const body =
      "Bancolombia: tu compra con T.cred *2575 por $92.000,00 no fue exitosa, los datos de tu t.cred estan incorrectos. 09:05 13/04/2026. ¿Dudas? 018000912345";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("type guard");
    expect(r.reason).toBe("failed");
  });

  it("skips info-personal updates", () => {
    const body =
      "Bancolombia: Listo. Actualizaste tu informacion personal en Sucursal Virtual, el 15/04/2026 a las 16:25. ¿No fuiste tu? Llamanos al 6045109000. A tu lado en cada paso.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("type guard");
    expect(r.reason).toBe("non_transactional");
  });

  it("skips authentication notifications", () => {
    const body =
      "Bancolombia: ...Listo. Te identificaste con tu clave principal en nuestra Sucursal Telefonica o en nuestro chat el 15/04/2026";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("type guard");
    expect(r.reason).toBe("non_transactional");
  });

  it("skips payments rejected by insufficient balance as 'failed'", () => {
    const body =
      "Bancolombia: Ups! El pago en EXPERIAN COLOMBIA por $ 23,900 fue rechazada por saldo insuficiente. Tu saldo actual es $ 2,728. Usa el saldo de bolsillos si lo deseas, alli tienes $ 40,000. Mueve tu plata facilmente desde nuestra App.";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("type guard");
    expect(r.reason).toBe("failed");
  });

  it("skips calendar/marketing reminders as non_transactional", () => {
    const bodies = [
      "Bancolombia:ALEJANDRO, es hora! Hay una actividad pendiente en Tu calendario. Revisala ya en app Mi Bancolombia >Explorar >Dia a Dia. Ya lo hiciste? Genial",
      "Bancolombia:Alejandro, planea, recuerda y paga facil tu tarjeta de credito con Tu calendario, lo nuevo de app Mi Bancolombia! Explorar >Dia a Dia >Tu calendario",
      "Bancolombia: Alejandro, tu recordatorio de pago esta activo, no dejes que se apague. Entra hoy a app Mi Bancolombia >Explorar >Dia a Dia >Tu Calendario",
    ];
    for (const body of bodies) {
      const r = parseSmsBancolombia(body);
      expect(r.kind).toBe("skip");
      if (r.kind !== "skip") throw new Error("type guard");
      expect(r.reason).toBe("non_transactional");
    }
  });

  it("skips yearly summary marketing as non_transactional", () => {
    const bodies = [
      "Bancolombia: Alejandro, tus gastos entre diciembre y enero cambiaron en $5.637.273. Conocelos en app Mi Bancolombia >Dia a Dia >Tus informes",
      "Bancolombia: Alejandro, quedan pocas horas para consultar tus gastos de $153.377.560 en 2025. Mi Bancolombia>Dia a Dia>Tus informes antes de que desaparezca",
      "Bancolombia: Alejandro, ChatGPT con $252.075 fue tu Top 1 en 2025. Actualizamos #TuInforme2025 en app Mi Bancolombia>Explorar>Dia a Dia>Tus Informes",
    ];
    for (const body of bodies) {
      const r = parseSmsBancolombia(body);
      expect(r.kind).toBe("skip");
      if (r.kind !== "skip") throw new Error("type guard");
      expect(r.reason).toBe("non_transactional");
    }
  });

  it("skips subscription heads-up and third-party-account registration", () => {
    const bodies = [
      "Bancolombia: Muy pronto cobraremos una suscripción asociada a tu tarjeta. Asegúrate de tener saldo suficiente. Verifícalo fácil en tu app. Contamos contigo.",
      "Bancolombia: Muy bien. Inscribiste la cuenta de un tercero desde APP Bancolombia. Si no fuiste tu, llamanos ahora: 6045109095 o 018000931987. Juntos en cada paso.",
    ];
    for (const body of bodies) {
      const r = parseSmsBancolombia(body);
      expect(r.kind).toBe("skip");
      if (r.kind !== "skip") throw new Error("type guard");
      expect(r.reason).toBe("non_transactional");
    }
  });

  it("skips unknown formats as 'unknown'", () => {
    const body = "Bancolombia: mensaje totalmente desconocido que no matchea nada";
    const r = parseSmsBancolombia(body);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("type guard");
    expect(r.reason).toBe("unknown");
  });
});

describe("resolveAccountFromLast4", () => {
  const accounts: RoutableAccount[] = [
    { id: 1, currency: "COP", metadata: { last4s: ["6126", "1802"] } },
    { id: 2, currency: "USD", metadata: { last4s: ["7073", "1356"] } },
    { id: 5, currency: "COP", metadata: { last4s: ["2575"], network: "visa" } },
    { id: 6, currency: "COP", metadata: { last4s: ["7291"], network: "mastercard" } },
    { id: 7, currency: "USD", metadata: { last4s: ["7291"], network: "mastercard" } },
    { id: 3, currency: "COP", metadata: null },
  ];

  it("routes savings account via its account number last-4", () => {
    const r = resolveAccountFromLast4("6126", "COP", accounts);
    expect(r?.id).toBe(1);
  });

  it("routes savings account via its debit card last-4", () => {
    const r = resolveAccountFromLast4("1802", "COP", accounts);
    expect(r?.id).toBe(1);
  });

  it("disambiguates dual-currency Mastercard by currency", () => {
    expect(resolveAccountFromLast4("7291", "COP", accounts)?.id).toBe(6);
    expect(resolveAccountFromLast4("7291", "USD", accounts)?.id).toBe(7);
  });

  it("returns null when no account matches", () => {
    expect(resolveAccountFromLast4("9999", "COP", accounts)).toBeNull();
  });

  it("returns null when last-4 matches but currency does not", () => {
    // *2575 is COP-only
    expect(resolveAccountFromLast4("2575", "USD", accounts)).toBeNull();
  });

  it("handles accounts with null or missing metadata", () => {
    expect(resolveAccountFromLast4("6126", "COP", accounts)?.id).toBe(1);
    // account with metadata: null (id=3) should not match anything
    expect(resolveAccountFromLast4("", "COP", accounts)).toBeNull();
  });
});

describe("parseSmsBancolombia — idempotency", () => {
  it("produces stable externalId for same SMS", () => {
    const body =
      "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const a = parseSmsBancolombia(body);
    const b = parseSmsBancolombia(body);
    if (a.kind === "skip" || b.kind === "skip") throw new Error("unexpected skip");
    expect(a.externalId).toBe(b.externalId);
  });

  it("produces different externalId for different amounts", () => {
    const bodyA =
      "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const bodyB =
      "Bancolombia: Compraste COP36.290,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const a = parseSmsBancolombia(bodyA);
    const b = parseSmsBancolombia(bodyB);
    if (a.kind === "skip" || b.kind === "skip") throw new Error("unexpected skip");
    expect(a.externalId).not.toBe(b.externalId);
  });
});
