import { createHash } from "node:crypto";
import type { AccountMetadata } from "@/lib/db/schema";

export type Currency = "COP" | "USD";

export type ParsedSmsBase = {
  occurredOn: string; // ISO date YYYY-MM-DD
  occurredTime: string; // HH:MM
  amountCents: bigint;
  currency: Currency;
  externalId: string;
  raw: string;
};

export type ParsedSms =
  | (ParsedSmsBase & {
      kind: "purchase";
      merchant: string;
      cardLast4: string;
      cardKind: "credit" | "debit";
    })
  | (ParsedSmsBase & {
      kind: "transfer_sent";
      fromLast4: string;
      toAccount: string;
      isQR: boolean;
    })
  | (ParsedSmsBase & {
      kind: "qr_payment";
      fromLast4: string;
      toKey: string;
    })
  | (ParsedSmsBase & {
      kind: "tc_payment";
      fromLast4: string;
      toCardLast4: string;
    })
  | (ParsedSmsBase & {
      kind: "transfer_received";
      senderName: string;
      toLast4: string;
    })
  | (ParsedSmsBase & {
      kind: "provider_payment";
      senderName: string;
    });

export type SkippedSms = {
  kind: "skip";
  reason: "failed" | "non_transactional" | "unknown";
  raw: string;
};

export type ParseResult = ParsedSms | SkippedSms;

// -----------------------------------------------------------------------------
// Amount parsing
// -----------------------------------------------------------------------------

/**
 * Parses Bancolombia SMS amount strings. Handles both EU and US formats:
 * - EU: "COP35.450,00", "USD195,26", "$92.000,00"
 * - US: "$30,000.00", "$56,000", "$1,320,564"
 *
 * Discriminator rule: if the string ends with a separator followed by exactly
 * 2 digits, that separator is the decimal. Otherwise no decimal part.
 */
export function parseSmsAmount(raw: string): { cents: bigint; currency: Currency } {
  const trimmed = raw.trim();
  let currency: Currency = "COP";
  let rest = trimmed;

  if (rest.startsWith("USD")) {
    currency = "USD";
    rest = rest.slice(3).trim();
  } else if (rest.startsWith("COP")) {
    currency = "COP";
    rest = rest.slice(3).trim();
  } else if (rest.startsWith("$")) {
    currency = "COP"; // bare "$" in Bancolombia SMS → COP
    rest = rest.slice(1).trim();
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
 * Parses Bancolombia SMS dates. Three formats observed:
 * - DD/MM/YYYY: "15/04/2026"
 * - DD/MM/YY:   "14/04/26"
 * - YYYY/MM/DD: "2026/04/12"
 *
 * Returns ISO date string "YYYY-MM-DD".
 */
export function parseSmsDate(raw: string): string {
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
// External ID
// -----------------------------------------------------------------------------

function hashId(parts: (string | bigint | number)[]): string {
  const payload = parts.map((p) => String(p)).join("|");
  return (
    "bcol-sms:" +
    createHash("sha256").update(payload).digest("hex").slice(0, 24)
  );
}

// -----------------------------------------------------------------------------
// Skip detection
// -----------------------------------------------------------------------------

const SKIP_PATTERNS: Array<{ pattern: RegExp; reason: SkippedSms["reason"] }> = [
  { pattern: /no\s+fue\s+exitosa/i, reason: "failed" },
  { pattern: /fue\s+rechazada\s+por\s+saldo\s+insuficiente/i, reason: "failed" },
  { pattern: /actualizaste\s+tu\s+informacion\s+personal/i, reason: "non_transactional" },
  { pattern: /te\s+identificaste/i, reason: "non_transactional" },
  { pattern: /tu\s+calendario/i, reason: "non_transactional" },
  { pattern: /tus\s+gastos\b/i, reason: "non_transactional" },
  { pattern: /fue\s+tu\s+Top\s+\d+/i, reason: "non_transactional" },
  { pattern: /recordatorio\s+de\s+pago/i, reason: "non_transactional" },
  { pattern: /muy\s+pronto\s+cobraremos/i, reason: "non_transactional" },
  { pattern: /inscribiste\s+la\s+cuenta\s+de\s+un\s+tercero/i, reason: "non_transactional" },
];

function detectSkip(body: string): SkippedSms["reason"] | null {
  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(body)) return reason;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Regex for each kind
//
// All patterns tolerate:
// - Optional leading "Bancolombia: " prefix (we consume the SMS body as-is)
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

// Purchase variant C: same as B but with TIME and DATE in reversed order:
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

// -----------------------------------------------------------------------------
// Main parser
// -----------------------------------------------------------------------------

export function parseSmsBancolombia(body: string): ParseResult {
  const raw = body.trim();

  const skip = detectSkip(raw);
  if (skip) return { kind: "skip", reason: skip, raw };

  // Purchase variant A
  {
    const m = raw.match(PURCHASE_A);
    if (m) {
      const { cents, currency } = parseSmsAmount(m[1]);
      const merchant = m[2].trim();
      const cardKind = cardKindFromMatch(m[3]);
      const cardLast4 = m[4];
      const occurredOn = parseSmsDate(m[5]);
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
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[1]);
      const merchant = m[2].trim();
      const occurredOn = parseSmsDate(m[3]);
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
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[1]);
      const merchant = m[2].trim();
      const occurredTime = m[3];
      const occurredOn = parseSmsDate(m[4]);
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
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[1]);
      const isQR = Boolean(m[2]);
      const fromLast4 = m[3].slice(-4);
      const toAccount = m[4];
      const occurredOn = parseSmsDate(m[5]);
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
        externalId: hashId([
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

  // QR payment
  {
    const m = raw.match(QR_PAYMENT);
    if (m) {
      const { cents, currency } = parseSmsAmount(m[1]);
      const fromLast4 = m[2].slice(-4);
      const toKey = m[3];
      const occurredOn = parseSmsDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "qr_payment",
        amountCents: cents,
        currency,
        fromLast4,
        toKey,
        occurredOn,
        occurredTime,
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[1]);
      const toCardLast4 = m[2];
      const fromLast4 = m[3].slice(-4);
      const occurredOn = parseSmsDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "tc_payment",
        amountCents: cents,
        currency,
        fromLast4,
        toCardLast4,
        occurredOn,
        occurredTime,
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[2]);
      const toLast4 = m[3].slice(-4);
      const occurredOn = parseSmsDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "transfer_received",
        amountCents: cents,
        currency,
        senderName,
        toLast4,
        occurredOn,
        occurredTime,
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[1]);
      const senderName = m[2].trim();
      const toLast4 = m[3].slice(-4);
      const occurredOn = parseSmsDate(m[4]);
      const occurredTime = m[5];
      return {
        kind: "transfer_received",
        amountCents: cents,
        currency,
        senderName,
        toLast4,
        occurredOn,
        occurredTime,
        externalId: hashId([
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
      const { cents, currency } = parseSmsAmount(m[2]);
      const occurredOn = parseSmsDate(m[3]);
      const occurredTime = m[4];
      return {
        kind: "provider_payment",
        amountCents: cents,
        currency,
        senderName,
        occurredOn,
        occurredTime,
        externalId: hashId([
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

  return { kind: "skip", reason: "unknown", raw };
}

// -----------------------------------------------------------------------------
// Account routing
// -----------------------------------------------------------------------------

export type RoutableAccount = {
  id: number;
  currency: Currency;
  metadata: AccountMetadata | null;
};

/**
 * Resolves an account by (last4, currency) against a list of accounts whose
 * `metadata.last4s` declares the identifiers that route to them. Both must
 * match for dual-currency cards (e.g. Mastercard *7291 COP vs USD) to work.
 *
 * Returns null when no account claims that last4+currency pair.
 */
export function resolveAccountFromLast4(
  last4: string,
  currency: Currency,
  accounts: RoutableAccount[],
): RoutableAccount | null {
  for (const acc of accounts) {
    const last4s = acc.metadata?.last4s ?? [];
    if (last4s.includes(last4) && acc.currency === currency) {
      return acc;
    }
  }
  return null;
}

