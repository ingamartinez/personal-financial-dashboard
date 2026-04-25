# Gmail receipt parsers

One parser per gateway. Each implements `GatewayParser.parse(html, opts?) → ParseResult`.

The orchestrator (`index.ts`) dispatches based on `email_receipts.gateway`. Bancolombia has a separate ingest path and is NOT routed through here — see `bancolombia.ts` and `processPendingBancolombiaReceipts` in `pull.ts`.

## Parsers

- `mercado-pago.ts` — flat-prose receipts; period=thousands, comma=decimal; Spanish date format
- `payu.ts` — labeled-table receipts; skip rejected + card-registration emails; Bogotá time (UTC-5)
- `wompi.ts` — labeled receipt with `WC-` reference; comma=thousands separator; no in-body date
- `apple.ts` — multiple email types from same sender; skip non-purchase variants; two invoice layouts
- `paypal.ts` — STUB until prod samples available

## Google Play / Google Pay

Verified absent in alpha user inbox (2026-04-23). Charges that look like Google Pay
(`DLO*DiDi Food CO Pay`) are actually **dLocal** (LATAM payment processor used by DiDi,
Spotify, Netflix, etc.) — dLocal does not send receipts itself; the merchant does.
**No parser added in MVP.** Reopen if Google Play receipts appear in any beta user's inbox.
