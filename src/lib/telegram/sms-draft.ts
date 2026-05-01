import type { AccountDetail } from "@/lib/accounts/queries";
import type { TelegramDraft } from "@/lib/db/schema";
import {
  resolveAccountFromLast4,
  type ParsedSms,
  type RoutableAccount,
} from "@/lib/ingestion/sms-bancolombia";

export type SmsDraftResult = {
  draft: TelegramDraft;
  externalId: string;
  occurredOn: string;
  raw: string;
  kind: ParsedSms["kind"];
};

function toRoutable(accounts: AccountDetail[]): Array<RoutableAccount & { institution: string }> {
  return accounts
    .filter((a) => a.active)
    .map((a) => ({
      id: a.id,
      currency: a.currency,
      metadata: a.metadata,
      institution: a.institution,
    }));
}

function resolveAccountId(parsed: ParsedSms, accounts: AccountDetail[]): number | undefined {
  const routable = toRoutable(accounts);
  let last4: string | null = null;
  switch (parsed.kind) {
    case "purchase":
      last4 = parsed.cardLast4;
      break;
    case "transfer_sent":
    case "qr_payment":
    case "tc_payment":
    case "provider_payment_sent":
    case "atm_withdrawal":
    case "bre_b_transfer":
      last4 = parsed.fromLast4;
      break;
    case "transfer_received":
      last4 = parsed.toLast4;
      break;
    case "tc_credit_received":
      last4 = parsed.toCardLast4;
      break;
    case "cartera_tc":
      // Cartera TC is handled by the wire path directly; the Telegram draft
      // flow is not used for this kind. Return undefined — the draft won't
      // be created through this path.
      return undefined;
    case "provider_payment": {
      // SMS says "en tu cuenta de Ahorros" with no last4 — pick the single
      // Bancolombia savings account in the matching currency.
      const match = routable.find(
        (a) => a.institution === "Bancolombia" && a.currency === parsed.currency,
      );
      return match?.id;
    }
  }
  if (!last4) return undefined;
  const match = resolveAccountFromLast4(last4, parsed.currency, routable);
  return match?.id;
}

function describe(parsed: ParsedSms): {
  merchant?: string;
  description: string;
  direction: "expense" | "income";
  categorySlug?: string;
} {
  switch (parsed.kind) {
    case "purchase":
      return {
        merchant: parsed.merchant,
        description: parsed.merchant,
        direction: "expense",
      };
    case "transfer_sent":
      return {
        description: `Transferencia${parsed.isQR ? " QR" : ""} a cuenta *${parsed.toAccount}`,
        direction: "expense",
        categorySlug: "transferencias",
      };
    case "qr_payment":
      return {
        description: `Pago QR a llave ${parsed.toKey}`,
        direction: "expense",
      };
    case "tc_payment":
      // #405: no category — transfers live outside spend/income taxonomy.
      // The confirm flow reads `draft.transfer` to know to insert as a group.
      return {
        description: `Pago TC *${parsed.toCardLast4}`,
        direction: "expense",
      };
    case "transfer_received":
      return {
        merchant: parsed.senderName,
        description: `Transferencia recibida de ${parsed.senderName}`,
        direction: "income",
        categorySlug: "ingresos",
      };
    case "provider_payment":
      return {
        merchant: parsed.senderName,
        description: `Pago PROVEEDOR de ${parsed.senderName}`,
        direction: "income",
        categorySlug: "ingresos",
      };
    case "provider_payment_sent":
      return {
        merchant: parsed.providerName,
        description: `Pago a ${parsed.providerName}`,
        direction: "expense",
      };
    case "atm_withdrawal":
      return {
        description: `Retiro ATM ${parsed.atmCode}`,
        direction: "expense",
      };
    case "tc_credit_received":
      // #405: single unpaired transfer leg — origin is external (we don't have
      // it in the SMS), so there's no companion credit. Direction is "income"
      // only in the cosmetic sense (money arrives at the TC reducing debt).
      return {
        merchant: parsed.senderName,
        description: `Abono de ${parsed.senderName} a TC *${parsed.toCardLast4}`,
        direction: "income",
      };
    case "bre_b_transfer":
      return {
        merchant: parsed.recipientName,
        description: `Transferencia Bre-b a ${parsed.recipientName}`,
        direction: "expense",
      };
    case "cartera_tc":
      // Cartera TC goes through the wire path directly (not Telegram draft).
      return {
        description: `Compra de Cartera TC (${parsed.months}×) *${parsed.tcCardLast4}`,
        direction: "expense",
      };
  }
}

export function buildDraftFromParsedSms(
  parsed: ParsedSms,
  accounts: AccountDetail[],
): SmsDraftResult {
  const accountId = resolveAccountId(parsed, accounts);
  const { merchant, description, direction, categorySlug } = describe(parsed);

  // #405: `tc_payment` → paired transfer group (destination resolved from
  // `toCardLast4`). `tc_credit_received` → single unpaired transfer leg
  // (origin is external / unknown).
  let transfer: TelegramDraft["transfer"];
  if (parsed.kind === "tc_payment") {
    const routable = toRoutable(accounts);
    const dest = resolveAccountFromLast4(parsed.toCardLast4, parsed.currency, routable);
    transfer = { destinationAccountId: dest?.id };
  } else if (parsed.kind === "tc_credit_received") {
    transfer = {};
  }

  // cartera_tc has no occurredOn in the SMS (no date). Fall back to today.
  const occurredOn =
    "occurredOn" in parsed ? parsed.occurredOn : new Date().toISOString().slice(0, 10);

  const draft: TelegramDraft = {
    amountCents: parsed.amountCents.toString(),
    currency: parsed.currency,
    direction,
    merchant,
    description,
    occurredOn,
    accountId,
    categorySlug,
    transfer,
  };

  return {
    draft,
    externalId: parsed.externalId,
    occurredOn,
    raw: parsed.raw,
    kind: parsed.kind,
  };
}
