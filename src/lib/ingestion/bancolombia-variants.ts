import { createHash } from "node:crypto";
import type { AccountMetadata } from "@/lib/db/schema";
import type { Currency } from "@/lib/types";

// Shared across Bancolombia ingestion sources (SMS #245, Email #457, future
// iOS native #Phase-5). Each source wraps this with its own skip-detection
// and externalId prefix.

export type ParsedBancolombiaTxBase = {
  occurredOn: string; // ISO date YYYY-MM-DD
  occurredTime: string; // HH:MM
  amountCents: bigint;
  currency: Currency;
  externalId: string;
  raw: string;
};

export type ParsedBancolombiaTx =
  | (ParsedBancolombiaTxBase & {
      kind: "purchase";
      merchant: string;
      cardLast4: string;
      cardKind: "credit" | "debit";
    })
  | (ParsedBancolombiaTxBase & {
      kind: "transfer_sent";
      fromLast4: string;
      toAccount: string;
      isQR: boolean;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "qr_payment";
      fromLast4: string;
      toKey: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "tc_payment";
      fromLast4: string;
      toCardLast4: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "transfer_received";
      senderName: string;
      toLast4: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "provider_payment";
      senderName: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "provider_payment_sent";
      providerName: string;
      fromLast4: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "atm_withdrawal";
      atmCode: string;
      fromLast4: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "tc_credit_received";
      senderName: string;
      toCardLast4: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "bre_b_transfer";
      fromLast4: string;
      toKey: string;
      recipientName: string;
    })
  | (ParsedBancolombiaTxBase & {
      kind: "transfer_received_to_savings";
      originDescriptor: string;
      // Note: occurredTime is stored here for display purposes only. It is NOT
      // part of the externalId computation for this variant. This is intentional:
      // Bancolombia has been observed sending the same payment notification twice
      // with different timestamps (4 minutes apart, prod logs 147+149). Using
      // semantic fields (sender + amount + date + origin) instead of the raw body
      // ensures both duplicates hash to the same externalId (#689).
      occurredTime: string;
    })
  | {
      // Note: cartera_tc has NO occurredOn/occurredTime — the SMS does not
      // include a date. The caller uses Date.now() / a known reference date.
      kind: "cartera_tc";
      amountCents: bigint;
      currency: "COP" | "USD";
      tcCardLast4: string;
      /** Raw uppercase network label from SMS: "AMEX" | "VISA" | "MASTERCARD" | etc. */
      tcNetwork: string;
      /** Rate in percent × 10000. 1.39% EM → 13900. */
      ratePercentX10k: number;
      /** Number of monthly installments in the plan (e.g. 60). */
      months: number;
      /** Dedup key: hash(sender + amountCents + last4 + months + ratePercentX10k). */
      externalId: string;
      raw: string;
    };

// Intentional skip: source recognized the message as a known non-ingest
// pattern (failed tx, non-transactional notification, statement notice).
// NOT a parse failure — the source chose to skip.
export type SkippedBancolombiaMessage = {
  kind: "skip";
  reason: "failed" | "non_transactional" | "statement_notification";
  raw: string;
};

// Parse failure: no variant matched. For SMS, this triggers AI fallback
// (#257). For email, this is logged and the receipt stays pending.
export type NeedsReviewBancolombiaMessage = {
  kind: "needs_review";
  reason: "unknown_pattern";
  raw: string;
};

export type BancolombiaParseResult =
  | ParsedBancolombiaTx
  | SkippedBancolombiaMessage
  | NeedsReviewBancolombiaMessage;

// -----------------------------------------------------------------------------
// Universal skip patterns
//
// These describe Bancolombia messages that both SMS and Email sources send
// and that are semantically "not a transaction to ingest" (failures,
// personal-info updates, login confirmations, summaries). Patterns that are
// known to collide with the marketing footer of transactional emails (e.g.
// "tus gastos", "tu calendario") are NOT here — they live in the SMS-only
// list in `sms-bancolombia.ts`.
// -----------------------------------------------------------------------------

export type SkipReason = "failed" | "non_transactional" | "statement_notification";

export const UNIVERSAL_SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: SkipReason }> = [
  { pattern: /no\s+fue\s+exitosa/i, reason: "failed" },
  { pattern: /fue\s+rechazada\s+por\s+saldo\s+insuficiente/i, reason: "failed" },
  { pattern: /actualizaste\s+tu\s+informacion\s+personal/i, reason: "non_transactional" },
  { pattern: /te\s+identificaste/i, reason: "non_transactional" },
  { pattern: /fue\s+tu\s+Top\s+\d+/i, reason: "non_transactional" },
  { pattern: /recordatorio\s+de\s+pago/i, reason: "non_transactional" },
  { pattern: /muy\s+pronto\s+cobraremos/i, reason: "non_transactional" },
  { pattern: /inscribiste\s+la\s+cuenta\s+de\s+un\s+tercero/i, reason: "non_transactional" },
];

// -----------------------------------------------------------------------------
// Amount parsing
// -----------------------------------------------------------------------------

/**
 * Parses Bancolombia amount strings. Handles both EU and US formats:
 * - EU: "COP35.450,00", "USD195,26", "$92.000,00"
 * - US: "$30,000.00", "$56,000", "$1,320,564"
 *
 * Discriminator rule: if the string ends with a separator followed by exactly
 * 2 digits, that separator is the decimal. Otherwise no decimal part.
 */
export function parseBancolombiaAmount(raw: string): { cents: bigint; currency: Currency } {
  const trimmed = raw.trim();
  let currency: Currency;
  let rest: string;

  if (trimmed.startsWith("USD")) {
    currency = "USD";
    rest = trimmed.slice(3).trim();
  } else if (trimmed.startsWith("COP")) {
    currency = "COP";
    rest = trimmed.slice(3).trim();
  } else if (trimmed.startsWith("$")) {
    currency = "COP";
    rest = trimmed.slice(1).trim();
  } else {
    throw new Error(`Unrecognized currency prefix: "${raw}"`);
  }

  const decimalMatch = rest.match(/^([\d.,]+?)([.,])(\d{2})$/);
  let intStr: string;
  let decStr: string;
  if (decimalMatch) {
    intStr = decimalMatch[1].replace(/[.,]/g, "");
    decStr = decimalMatch[3];
  } else {
    intStr = rest.replace(/[.,]/g, "");
    decStr = "00";
  }

  if (!/^\d+$/.test(intStr) || !/^\d{2}$/.test(decStr)) {
    throw new Error(`Invalid amount: "${raw}"`);
  }
  const cents = BigInt(intStr) * BigInt(100) + BigInt(decStr);
  return { cents, currency };
}

// -----------------------------------------------------------------------------
// Date parsing
// -----------------------------------------------------------------------------

/**
 * Parses Bancolombia dates. Three formats observed:
 * - DD/MM/YYYY: "15/04/2026"
 * - DD/MM/YY:   "14/04/26"
 * - YYYY/MM/DD: "2026/04/12"
 *
 * Returns ISO date string "YYYY-MM-DD".
 */
export function parseBancolombiaDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/);
  if (!m) throw new Error(`Invalid date: "${raw}"`);

  let year: number;
  let month: number;
  let day: number;
  if (m[1].length === 4) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else if (m[3].length === 4) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  } else if (m[3].length === 2) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = 2000 + Number(m[3]);
  } else {
    throw new Error(`Ambiguous date: "${raw}"`);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date values: "${raw}"`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------------
// External ID — source-parameterized so SMS vs email vs iOS-native stay
// distinct in (account_id, external_id) uniqueness.
// -----------------------------------------------------------------------------

function hashId(prefix: string, parts: (string | bigint | number)[]): string {
  const payload = parts.map((p) => String(p)).join("|");
  return `${prefix}:` + createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

// -----------------------------------------------------------------------------
// Regex for each variant
//
// All patterns tolerate:
// - Optional leading "Bancolombia: " prefix
// - Optional "*" or "**" before last-4 numbers
// - Date in any of the 3 formats
// - Time with or without "a las " preamble
// - US and EU amount formats (amount group is parsed separately)
// -----------------------------------------------------------------------------

const AMOUNT_GROUP = /(COP[\d.,]+|USD[\d.,]+|\$[\d.,]+)/.source;
const DATE_GROUP = /(\d{1,4}\/\d{1,2}\/\d{1,4})/.source;
const TIME_GROUP = /(\d{1,2}:\d{2})/.source;
const DATE_TIME = `${DATE_GROUP}(?:\\s+a\\s+las\\s+|\\s+)${TIME_GROUP}`;

// Purchase variant A: "Compraste AMOUNT en MERCHANT con tu T.{Cred|Deb} *NNNN, el DATE a las TIME"
const PURCHASE_A = new RegExp(
  `Compraste\\s+${AMOUNT_GROUP}\\s+en\\s+(.+?)\\s+con\\s+tu\\s+T\\.(Cred|Deb)\\s+\\*(\\d{4})[,.]?\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Purchase variant B: "Compraste AMOUNT en MERCHANT, el DATE a las TIME. Esta compra esta asociada a T.{Cred|Deb} *NNNN"
const PURCHASE_B = new RegExp(
  `Compraste\\s+${AMOUNT_GROUP}\\s+en\\s+(.+?),\\s+el\\s+${DATE_TIME}\\.\\s+Esta\\s+compra\\s+esta\\s+asociada\\s+a\\s+T\\.(Cred|Deb)\\s+\\*(\\d{4})`,
  "i",
);

// Purchase variant C (reversed TIME/DATE order):
// "Compraste AMOUNT en MERCHANT, el TIME a las DATE. Esta compra esta asociada a T.{Cred|Deb} *NNNN"
const PURCHASE_C = new RegExp(
  `Compraste\\s+${AMOUNT_GROUP}\\s+en\\s+(.+?),\\s+el\\s+${TIME_GROUP}\\s+a\\s+las\\s+${DATE_GROUP}\\.\\s+Esta\\s+compra\\s+esta\\s+asociada\\s+a\\s+T\\.(Cred|Deb)\\s+\\*(\\d{4})`,
  "i",
);

function cardKindFromMatch(token: string): "credit" | "debit" {
  return token.toLowerCase() === "deb" ? "debit" : "credit";
}

// Transfer sent: "Transferiste AMOUNT [por QR] desde tu cuenta *NNNN a la cuenta *NNNN[,] el DATE [a las] TIME"
const TRANSFER_SENT = new RegExp(
  `Transferiste\\s+${AMOUNT_GROUP}(\\s+por\\s+QR)?\\s+desde\\s+tu\\s+cuenta\\s+\\*?(\\d{4,})\\s+a\\s+la\\s+cuenta\\s+\\*?(\\d+)[,.]?\\s+el\\s+${DATE_TIME}`,
  "i",
);

// QR payment: "<NAME> pagaste AMOUNT por codigo QR desde tu cuenta *NNNN a la llave NNNN el DATE a las TIME"
const QR_PAYMENT = new RegExp(
  `pagaste\\s+${AMOUNT_GROUP}\\s+por\\s+codigo\\s+QR\\s+desde\\s+tu\\s+cuenta\\s+\\*?(\\d{4,})\\s+a\\s+la\\s+llave\\s+(\\d+)\\s+el\\s+${DATE_TIME}`,
  "i",
);

// TC payment: "Pagaste AMOUNT en la tarjeta de credito *NNNN desde la cuenta *NNNN, el DATE [a las] TIME"
const TC_PAYMENT = new RegExp(
  `Pagaste\\s+${AMOUNT_GROUP}\\s+en\\s+la\\s+tarjeta\\s+de\\s+credito\\s+\\*(\\d{4})\\s+desde\\s+la\\s+cuenta\\s+\\*?(\\d{4,})[,.]?\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Transfer received variant A: "<NAME>, recibiste una transferencia de SENDER por AMOUNT en tu cuenta *NNNN conectada a la llave NNN el DATE a las TIME"
const TRANSFER_RECV_A = new RegExp(
  `recibiste\\s+una\\s+transferencia\\s+de\\s+(.+?)\\s+por\\s+${AMOUNT_GROUP}\\s+en\\s+tu\\s+cuenta\\s+\\*+(\\d{4,})\\s+conectada\\s+a\\s+la\\s+llave\\s+\\d+\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Transfer received variant B: "Recibiste una transferencia por AMOUNT de SENDER en tu cuenta **NNNN, el DATE a las TIME"
const TRANSFER_RECV_B = new RegExp(
  `Recibiste\\s+una\\s+transferencia\\s+por\\s+${AMOUNT_GROUP}\\s+de\\s+(.+?)\\s+en\\s+tu\\s+cuenta\\s+\\*+(\\d{4,})[,.]?\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Provider payment: "Recibiste un pago PROVEEDOR de SENDER por AMOUNT en tu cuenta de Ahorros el DATE a las TIME"
const PROVIDER_PAYMENT = new RegExp(
  `Recibiste\\s+un\\s+pago\\s+PROVEEDOR\\s+de\\s+(.+?)\\s+por\\s+${AMOUNT_GROUP}\\s+en\\s+tu\\s+cuenta\\s+de\\s+Ahorros\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Provider payment sent (PSE / bill-pay):
// "Pagaste AMOUNT a PROVIDER desde tu producto *NNNN el DD/MM/YYYY HH:MM:SS"
const PROVIDER_PAYMENT_SENT = new RegExp(
  `Pagaste\\s+${AMOUNT_GROUP}\\s+a\\s+(.+?)\\s+desde\\s+tu\\s+producto\\s+\\*?(\\d{4,})\\s+el\\s+${DATE_GROUP}\\s+${TIME_GROUP}(?::\\d{2})?`,
  "i",
);

// ATM withdrawal: "Retiraste AMOUNT en ATM_CODE de tu T.Deb *NNNN el DATE a las TIME"
const ATM_WITHDRAWAL = new RegExp(
  `Retiraste\\s+${AMOUNT_GROUP}\\s+en\\s+(\\S+)\\s+de\\s+tu\\s+T\\.Deb\\s+\\*+(\\d{4})\\s+el\\s+${DATE_TIME}`,
  "i",
);

// TC credit received: "<SENDER> hizo un abono por AMOUNT a tu tarjeta de credito terminada en *NNNN, el DATE TIME"
const TC_CREDIT_RECEIVED = new RegExp(
  `(?:Bancolombia:\\s*)?(.+?)\\s+hizo\\s+un\\s+abono\\s+por\\s+${AMOUNT_GROUP}\\s+a\\s+tu\\s+tarjeta\\s+de\\s+credito\\s+terminada\\s+en\\s+\\*+(\\d{4})[,.]?\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Bre-b transfer: "<USER>, transferiste AMOUNT a la llave NNNN desde tu cuenta *NNNN a <RECIPIENT_NAME> el DATE a las TIME..."
const BRE_B_TRANSFER = new RegExp(
  `transferiste\\s+${AMOUNT_GROUP}\\s+a\\s+la\\s+llave\\s+(\\d+)\\s+desde\\s+tu\\s+cuenta\\s+\\*?(\\d{4,})\\s+a\\s+(.+?)\\s+el\\s+${DATE_TIME}`,
  "i",
);

// Transfer received to savings (third-party pago landing in cta Ahorros):
// "Bancolombia: Recibiste un pago por $AMOUNT de ORIGIN a tu cuenta AHORROS, el HH:MM a las DD/MM/YYYY..."
// Distinct from TRANSFER_RECV_A/B (those involve inter-Bancolombia transfers with a *last4)
// and from PROVIDER_PAYMENT (that requires the literal "PROVEEDOR" keyword).
// This shape appears when DIAN, Tesoro Nacional, or any external institution wires
// money directly to the user's savings account. No account last4 is present.
const TRANSFER_RECV_TO_SAVINGS = new RegExp(
  `Recibiste\\s+un\\s+pago\\s+por\\s+${AMOUNT_GROUP}\\s+de\\s+(.+?)\\s+a\\s+tu\\s+cuenta\\s+AHORROS[,.]?\\s+el\\s+${TIME_GROUP}\\s+a\\s+las\\s+${DATE_GROUP}`,
  "i",
);

// Cartera TC: "Bancolombia confirma compra de cartera por $29,000,000.00 en su TC AMEX *5367. La tasa es de 1.39% y el plazo de 60 meses."
// No date/time in this SMS — the caller provides occurredAt from context.
const CARTERA_TC = new RegExp(
  `Bancolombia\\s+confirma\\s+compra\\s+de\\s+cartera\\s+por\\s+${AMOUNT_GROUP}\\s+en\\s+su\\s+TC\\s+(\\w+)\\s+\\*(\\d{4})\\.?\\s+La\\s+tasa\\s+es\\s+de\\s+(\\d+(?:[.,]\\d+)?)%\\s+y\\s+el\\s+plazo\\s+de\\s+(\\d+)\\s+meses`,
  "i",
);

// -----------------------------------------------------------------------------
// Variant matcher — returns null if nothing matches. Each caller (SMS, email,
// future iOS native) wraps this with source-specific skip detection and
// failure handling.
//
// externalIdPrefix: keeps (account_id, external_id) uniqueness disjoint across
// sources. A second ingestion of the same text from the same source collides;
// the same underlying event across sources does not (cross-source dedup is
// handled at the application layer via A+ match).
// -----------------------------------------------------------------------------

export function matchBancolombiaVariant(
  body: string,
  opts: { externalIdPrefix: string },
): ParsedBancolombiaTx | null {
  // cartera_tc: MUST be checked before any broad patterns. The phrase
  // "Bancolombia confirma compra de cartera" is unambiguous, so it goes first.
  {
    const m = body.trim().match(CARTERA_TC);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const tcNetwork = m[2].toUpperCase();
      const tcCardLast4 = m[3];
      const rateStr = m[4].replace(",", ".");
      const ratePercentX10k = Math.round(parseFloat(rateStr) * 10000);
      const months = parseInt(m[5], 10);
      return {
        kind: "cartera_tc",
        amountCents: cents,
        currency: currency as "COP" | "USD",
        tcCardLast4,
        tcNetwork,
        ratePercentX10k,
        months,
        externalId: hashId(opts.externalIdPrefix, [
          "cartera-tc",
          tcCardLast4,
          String(cents),
          months,
          ratePercentX10k,
        ]),
        raw: body.trim(),
      };
    }
  }
  const raw = body.trim();
  const prefix = opts.externalIdPrefix;

  // Purchase variant A
  {
    const m = raw.match(PURCHASE_A);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const merchant = m[2].trim();
      const cardKind = cardKindFromMatch(m[3]);
      const cardLast4 = m[4];
      const occurredOn = parseBancolombiaDate(m[5]);
      const occurredTime = m[6];
      return {
        kind: "purchase",
        amountCents: cents,
        currency,
        merchant,
        cardLast4,
        cardKind,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "purchase",
          cardLast4,
          currency,
          occurredOn,
          occurredTime,
          cents,
          merchant,
        ]),
        raw,
      };
    }
  }

  // Purchase variant B
  {
    const m = raw.match(PURCHASE_B);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const merchant = m[2].trim();
      const occurredOn = parseBancolombiaDate(m[3]);
      const occurredTime = m[4];
      const cardKind = cardKindFromMatch(m[5]);
      const cardLast4 = m[6];
      return {
        kind: "purchase",
        amountCents: cents,
        currency,
        merchant,
        cardLast4,
        cardKind,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "purchase",
          cardLast4,
          currency,
          occurredOn,
          occurredTime,
          cents,
          merchant,
        ]),
        raw,
      };
    }
  }

  // Purchase variant C (reversed TIME/DATE order)
  {
    const m = raw.match(PURCHASE_C);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const merchant = m[2].trim();
      const occurredTime = m[3];
      const occurredOn = parseBancolombiaDate(m[4]);
      const cardKind = cardKindFromMatch(m[5]);
      const cardLast4 = m[6];
      return {
        kind: "purchase",
        amountCents: cents,
        currency,
        merchant,
        cardLast4,
        cardKind,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "purchase",
          cardLast4,
          currency,
          occurredOn,
          occurredTime,
          cents,
          merchant,
        ]),
        raw,
      };
    }
  }

  // Transfer sent
  {
    const m = raw.match(TRANSFER_SENT);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const isQR = Boolean(m[2]);
      const fromLast4 = m[3].slice(-4);
      const toAccount = m[4];
      const occurredOn = parseBancolombiaDate(m[5]);
      const occurredTime = m[6];
      return {
        kind: "transfer_sent",
        amountCents: cents,
        currency,
        fromLast4,
        toAccount,
        isQR,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "transfer-sent",
          fromLast4,
          toAccount,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Bre-b transfer (BEFORE generic QR/transfer checks — more specific)
  {
    const m = raw.match(BRE_B_TRANSFER);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const toKey = m[2];
      const fromLast4 = m[3].slice(-4);
      const recipientName = m[4].trim();
      const occurredOn = parseBancolombiaDate(m[5]);
      const occurredTime = m[6];
      return {
        kind: "bre_b_transfer",
        amountCents: cents,
        currency,
        fromLast4,
        toKey,
        recipientName,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "bre-b-transfer",
          fromLast4,
          toKey,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // QR payment
  {
    const m = raw.match(QR_PAYMENT);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const fromLast4 = m[2].slice(-4);
      const toKey = m[3];
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "qr_payment",
        amountCents: cents,
        currency,
        fromLast4,
        toKey,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "qr-payment",
          fromLast4,
          toKey,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // TC payment
  {
    const m = raw.match(TC_PAYMENT);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const toCardLast4 = m[2];
      const fromLast4 = m[3].slice(-4);
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "tc_payment",
        amountCents: cents,
        currency,
        fromLast4,
        toCardLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "tc-payment",
          fromLast4,
          toCardLast4,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Transfer received variant A
  {
    const m = raw.match(TRANSFER_RECV_A);
    if (m) {
      const senderName = m[1].trim();
      const { cents, currency } = parseBancolombiaAmount(m[2]);
      const toLast4 = m[3].slice(-4);
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "transfer_received",
        amountCents: cents,
        currency,
        senderName,
        toLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "transfer-received",
          toLast4,
          senderName,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Transfer received variant B
  {
    const m = raw.match(TRANSFER_RECV_B);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const senderName = m[2].trim();
      const toLast4 = m[3].slice(-4);
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "transfer_received",
        amountCents: cents,
        currency,
        senderName,
        toLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "transfer-received",
          toLast4,
          senderName,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Provider payment
  {
    const m = raw.match(PROVIDER_PAYMENT);
    if (m) {
      const senderName = m[1].trim();
      const { cents, currency } = parseBancolombiaAmount(m[2]);
      const occurredOn = parseBancolombiaDate(m[3]);
      const occurredTime = m[4];
      return {
        kind: "provider_payment",
        amountCents: cents,
        currency,
        senderName,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "provider-payment",
          senderName,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Provider payment sent (PSE / bill-pay)
  {
    const m = raw.match(PROVIDER_PAYMENT_SENT);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const providerName = m[2].trim();
      const fromLast4 = m[3].slice(-4);
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "provider_payment_sent",
        amountCents: cents,
        currency,
        providerName,
        fromLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "provider-payment-sent",
          fromLast4,
          providerName,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // ATM withdrawal
  {
    const m = raw.match(ATM_WITHDRAWAL);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const atmCode = m[2];
      const fromLast4 = m[3];
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "atm_withdrawal",
        amountCents: cents,
        currency,
        atmCode,
        fromLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "atm-withdrawal",
          fromLast4,
          atmCode,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // TC credit received (third party paid down my credit card)
  {
    const m = raw.match(TC_CREDIT_RECEIVED);
    if (m) {
      const senderName = m[1].trim();
      const { cents, currency } = parseBancolombiaAmount(m[2]);
      const toCardLast4 = m[3];
      const occurredOn = parseBancolombiaDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "tc_credit_received",
        amountCents: cents,
        currency,
        senderName,
        toCardLast4,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "tc-credit-received",
          toCardLast4,
          senderName,
          occurredOn,
          occurredTime,
          cents,
        ]),
        raw,
      };
    }
  }

  // Transfer received to savings (third-party institution paying directly into
  // savings account — DIAN, Tesoro Nacional, external employer, etc.)
  //
  // ExternalId strategy: uses semantic fields (sender + amount + date + origin)
  // rather than raw body. Bancolombia has been observed sending the same payment
  // notification twice with timestamps 4 minutes apart (prod logs 147+149, #689).
  // Hashing the body would produce different IDs → duplicate tx. Hashing semantic
  // fields ensures both copies of the notification map to the same externalId.
  // occurredTime is preserved on the struct for display only, NOT in the hash.
  // This is variant-specific — other variants keep their body-based hash.
  {
    const m = raw.match(TRANSFER_RECV_TO_SAVINGS);
    if (m) {
      const { cents, currency } = parseBancolombiaAmount(m[1]);
      const originDescriptor = m[2].trim();
      const occurredTime = m[3];
      const occurredOn = parseBancolombiaDate(m[4]);
      return {
        kind: "transfer_received_to_savings",
        amountCents: cents,
        currency,
        originDescriptor,
        occurredOn,
        occurredTime,
        externalId: hashId(prefix, [
          "transfer-received-to-savings",
          // sender is the external ID prefix (e.g. "bcol-sms" with its underlying
          // SMS sender number). We fold the prefix itself (which encodes the sender
          // channel) together with semantic fields so cross-source dedup stays clean.
          prefix,
          String(cents),
          currency,
          occurredOn,
          originDescriptor,
        ]),
        raw,
      };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Account routing — shared across sources.
// -----------------------------------------------------------------------------

export type RoutableAccount = {
  id: number;
  currency: Currency;
  metadata: AccountMetadata | null;
  /**
   * The parent physical_card's last4, when this account is linked to one.
   * Null for standalone accounts (savings, single-currency debit, etc.).
   * Used as a fallback by resolveAccountFromLast4 when metadata.last4s is
   * empty — handles the multi-currency drift class (#693).
   */
  physicalCardLast4: string | null;
};

/**
 * Resolves an account by (last4, currency) against a list of accounts.
 *
 * Two-source resolution to handle the multi-currency drift class (#693):
 *   - metadata.last4s is the per-account list (form-managed, can be empty)
 *   - physicalCardLast4 is the parent card's last4 (always present when linked)
 *
 * Match if EITHER source includes last4 AND currency matches. Prefer
 * metadata.last4s first (existing behavior, no change for correct data).
 * Falls back to physicalCardLast4 only when metadata.last4s has no match.
 *
 * Returns null when no account claims that last4+currency pair.
 */
export function resolveAccountFromLast4(
  last4: string,
  currency: Currency,
  accounts: RoutableAccount[],
): RoutableAccount | null {
  for (const acc of accounts) {
    if (acc.currency !== currency) continue;
    const last4s = acc.metadata?.last4s ?? [];
    if (last4s.includes(last4)) return acc;
    if (acc.physicalCardLast4 === last4) return acc;
  }
  return null;
}
