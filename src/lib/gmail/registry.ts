import type { PgEnum } from "drizzle-orm/pg-core";
import { emailReceiptGateway } from "@/lib/db/schema";

// Mirror the pgEnum so the registry's GatewayId stays in lockstep with the
// DB column type. If a new gateway is added to the enum, a missing registry
// entry will surface as a TS error where the registry is consumed.
type EnumValues<T> = T extends PgEnum<infer V> ? V[number] : never;
export type GatewayId = EnumValues<typeof emailReceiptGateway>;

export const GATEWAY_MODES = ["enrich", "ingest", "evidence"] as const;
export type GatewayMode = (typeof GATEWAY_MODES)[number];

export interface GatewayConfig {
  id: GatewayId;
  // Gmail search query fragments. Combined with OR at pull time; each is
  // dropped verbatim into users.messages.list?q=... . Keep them narrow —
  // broader filters (domain wildcards) let spoofed/marketing mail slip in.
  senderQueries: string[];
  // Matcher (#454) uses this to check whether a bank tx description
  // plausibly corresponds to a receipt from this gateway. `null` for
  // `ingest` and `evidence` gateways: the matcher never tries to pair their
  // receipts with a bank tx, so no regex is needed. Values sourced from
  // PLAN.md §Gateway opacity table. Word boundaries on each pattern so
  // they only match whole tokens in the bank's description line.
  bankDescriptionRegex: RegExp | null;
  // `enrich`: receipts are matched back to bank transactions and used to
  // overwrite merchant/category when the bank description is opaque.
  // `ingest`: receipts are ingested as transactions themselves (Bancolombia
  // email is a parallel ingestion source to SMS — #457).
  // `evidence`: persist the receipt for the tx-first correlator; never
  // insert a transaction and never overwrite the bank merchant. JetSmart
  // itineraries are the exemplar (#814 Phase 1 design).
  mode: GatewayMode;
}

// Source: PLAN.md §6b + §Gateway opacity table. Senders investigated from
// real inbox samples; domain-anchored to avoid spoof matches.
export const GATEWAYS: readonly GatewayConfig[] = [
  {
    id: "mercado_pago",
    // `.com.co` was the originally documented pair. Prod EMI receipts were
    // ingested via `@mercadopago.com` (Gmail domain queries match
    // subdomains: email./a./r.mercadopago.com). A keyword search
    // `from:mercadopago.com.co` returning zero is not a missing-sender bug
    // (#814 1e). Mercado Libre "Compraste …" confirmations carry the
    // product line + voucher block and are the same bank-facing gateway
    // (MERCADOPAGO COLOMBIA), so they share this enrich entry.
    // `@mercadolibre.com` / `@mercadolibre.com.co` also cover observed
    // subdomains (no-responder., a., r.) without listing each one.
    senderQueries: [
      "from:(@mercadopago.com.co)",
      "from:(@mercadopago.com)",
      "from:(@mercadolibre.com.co)",
      "from:(@mercadolibre.com)",
    ],
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
  // ARQ (formerly DolarApp) — capture-only for now. See #508 for the real
  // parser. Using `mode: "ingest"` here means the pull engine persists every
  // matching email into email_receipts (raw_html intact, parsed_payload NULL)
  // before any per-mode processing runs. The hardcoded `if (g.id ===
  // "bancolombia")` block in pull.ts means ARQ emails are stored but never
  // processed — intentional until #508 implements the parser. The accumulated
  // raw_html corpus will drive the parser design for #508.
  {
    id: "arq",
    senderQueries: ["from:(@arqfinance.com)", "from:(@dolarapp.com)"],
    // Capture-only: matcher never runs for ingest gateways.
    bankDescriptionRegex: null,
    mode: "ingest",
  },
  // JetSmart itineraries identify a bank charge (tx 1443) without being
  // the charge. Persist for correlation; never insert a tx; never overwrite
  // the bank merchant. Domain-anchored so spoofed From: headers miss.
  // `@jetsmart.com` covers jetsmart@mg.jetsmart.com (the observed sender).
  {
    id: "jetsmart",
    senderQueries: ["from:(@jetsmart.com)"],
    bankDescriptionRegex: null,
    mode: "evidence",
  },
] as const;

// Tuple of all gateway IDs — used by the cron route for Zod enum validation.
// Derived from GATEWAYS so it stays in lockstep automatically.
export const GATEWAY_IDS = GATEWAYS.map((g) => g.id) as [GatewayId, ...GatewayId[]];

export function getGatewayById(id: GatewayId): GatewayConfig {
  const cfg = GATEWAYS.find((g) => g.id === id);
  if (!cfg) throw new Error(`[gmail/registry] unknown gateway id: ${id}`);
  return cfg;
}

export function isEvidenceGateway(id: GatewayId): boolean {
  return getGatewayById(id).mode === "evidence";
}

export function evidenceGatewayIds(): GatewayId[] {
  return GATEWAYS.filter((g) => g.mode === "evidence").map((g) => g.id);
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

const SENDER_QUERY_RE = /^from:\(@([^)]+)\)$/;

export function senderQueryDomain(query: string): string | null {
  const m = SENDER_QUERY_RE.exec(query);
  return m ? m[1].toLowerCase() : null;
}

/** Accept `jetsmart.com`, `@jetsmart.com`, or `from:(@jetsmart.com)`. */
export function normalizeSenderDomain(raw: string): string {
  const s = raw.trim().toLowerCase();
  const fromMatch = SENDER_QUERY_RE.exec(s);
  if (fromMatch) return fromMatch[1];
  return s.startsWith("@") ? s.slice(1) : s;
}

function domainMatchesRequested(registered: string, requested: string): boolean {
  return registered === requested || registered.endsWith("." + requested);
}

export type SenderPullPlan = {
  gateway: GatewayConfig;
  senderQueries: string[];
};

/**
 * Map operator-facing sender domains onto the registered senderQueries they
 * cover, grouped by gateway. `mercadolibre.com` does NOT match
 * `@mercadolibre.com.co` (`.com.co` is not a subdomain of `.com`).
 *
 * Used by the historical fetch (#849) so a newly registered sender can be
 * pulled without re-listing every other sender on the same gateway.
 */
export function resolveRegisteredSenders(senders: string[]): SenderPullPlan[] {
  if (senders.length === 0) {
    throw new Error("[gmail/registry] resolveRegisteredSenders requires at least one sender");
  }
  const unmatched: string[] = [];
  const byGateway = new Map<GatewayId, SenderPullPlan>();

  for (const raw of senders) {
    const requested = normalizeSenderDomain(raw);
    if (requested.length === 0) {
      unmatched.push(raw);
      continue;
    }
    let matched = false;
    for (const g of GATEWAYS) {
      const hits = g.senderQueries.filter((q) => {
        const d = senderQueryDomain(q);
        return d !== null && domainMatchesRequested(d, requested);
      });
      if (hits.length === 0) continue;
      matched = true;
      const existing = byGateway.get(g.id);
      if (existing) {
        for (const h of hits) {
          if (!existing.senderQueries.includes(h)) existing.senderQueries.push(h);
        }
      } else {
        byGateway.set(g.id, { gateway: g, senderQueries: [...hits] });
      }
    }
    if (!matched) unmatched.push(requested);
  }

  if (unmatched.length > 0) {
    throw new Error(`[gmail/registry] sender(s) not registered: ${unmatched.join(", ")}`);
  }
  return [...byGateway.values()];
}
