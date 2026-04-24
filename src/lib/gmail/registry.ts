import type { PgEnum } from "drizzle-orm/pg-core";
import { emailReceiptGateway } from "@/lib/db/schema";

// Mirror the pgEnum so the registry's GatewayId stays in lockstep with the
// DB column type. If a new gateway is added to the enum, a missing registry
// entry will surface as a TS error where the registry is consumed.
type EnumValues<T> = T extends PgEnum<infer V> ? V[number] : never;
export type GatewayId = EnumValues<typeof emailReceiptGateway>;

export type GatewayMode = "enrich" | "ingest";

export interface GatewayConfig {
  id: GatewayId;
  // Gmail search query fragments. Combined with OR at pull time; each is
  // dropped verbatim into users.messages.list?q=... . Keep them narrow —
  // broader filters (domain wildcards) let spoofed/marketing mail slip in.
  senderQueries: string[];
  // Matcher (#454) uses this to check whether a bank tx description
  // plausibly corresponds to a receipt from this gateway. `null` for
  // `ingest` gateways (bancolombia): the matcher never tries to pair their
  // receipts with a bank tx, so no regex is needed. Values sourced from
  // PLAN.md §Gateway opacity table. Word boundaries on each pattern so
  // they only match whole tokens in the bank's description line.
  bankDescriptionRegex: RegExp | null;
  // `enrich`: receipts are matched back to bank transactions and used to
  // overwrite merchant/category when the bank description is opaque.
  // `ingest`: receipts are ingested as transactions themselves (Bancolombia
  // email is a parallel ingestion source to SMS — #457).
  mode: GatewayMode;
}

// Source: PLAN.md §6b + §Gateway opacity table. Senders investigated from
// real inbox samples; domain-anchored to avoid spoof matches.
export const GATEWAYS: readonly GatewayConfig[] = [
  {
    id: "mercado_pago",
    senderQueries: ["from:(@mercadopago.com.co)", "from:(@mercadopago.com)"],
    bankDescriptionRegex: /\bMERCADOPAGO\b/i,
    mode: "enrich",
  },
  {
    id: "payu",
    senderQueries: ["from:(@payu.com)", "from:(@payulatam.com)"],
    bankDescriptionRegex: /\bPAYU\b/i,
    mode: "enrich",
  },
  {
    id: "wompi",
    senderQueries: ["from:(@wompi.co)"],
    bankDescriptionRegex: /\bWOMPI\b/i,
    mode: "enrich",
  },
  {
    id: "apple",
    // Domain-level: catches `no_reply@`, `do_not_reply@`, the underscore-less
    // `noreply@` variant observed in prod, and future Apple senders at this
    // domain. Sibling domains (insideapple.apple.com, id.apple.com) are
    // marketing + account-security and intentionally excluded.
    senderQueries: ["from:(@email.apple.com)"],
    bankDescriptionRegex: /\bAPPLE\.COM\/BILL\b/i,
    mode: "enrich",
  },
  {
    id: "paypal",
    // Domain-level covers service@paypal.com, service@intl.paypal.com, and
    // any future subdomain. `@paypal.com` in Gmail matches the root domain
    // AND subdomains, so `@intl.paypal.com` is strictly redundant — kept
    // for readability of intent.
    senderQueries: ["from:(@paypal.com)", "from:(@intl.paypal.com)"],
    bankDescriptionRegex: /\bPAYPAL\b/i,
    mode: "enrich",
  },
  {
    id: "bancolombia",
    // Domain-level for the transactional alert domain (used to be the
    // specific `alertasynotificaciones@…` email — domain-level is
    // future-proof when Bancolombia rotates the local-part). Plus the
    // extractos domain for monthly statements. Marketing-only domains
    // (correobancolombia.com, tubienestarfinanciero.*) are deliberately
    // excluded to keep the receipt corpus signal-dense.
    senderQueries: [
      "from:(@an.notificacionesbancolombia.com)",
      "from:(@bancolombia.com.co)",
      "from:(@extractos.documentosbancolombia.com)",
    ],
    // Bancolombia is direct-ingest: the matcher never tries to pair an email
    // receipt with a bank tx (the email *is* the source of truth).
    bankDescriptionRegex: null,
    mode: "ingest",
  },
] as const;

export function getGatewayById(id: GatewayId): GatewayConfig {
  const cfg = GATEWAYS.find((g) => g.id === id);
  if (!cfg) throw new Error(`[gmail/registry] unknown gateway id: ${id}`);
  return cfg;
}

// Compose the `from:(...) OR from:(...)` portion of the Gmail query for one
// gateway. Callers append the `after:` and any other constraints.
export function buildSenderQuery(cfg: GatewayConfig): string {
  if (cfg.senderQueries.length === 0) {
    throw new Error(`[gmail/registry] gateway ${cfg.id} has empty senderQueries`);
  }
  if (cfg.senderQueries.length === 1) return cfg.senderQueries[0];
  return `(${cfg.senderQueries.join(" OR ")})`;
}
