#!/usr/bin/env bash
# Smoke test for POST /api/ingest/sms using real Bancolombia SMS samples.
#
# Usage:
#   ./scripts/test-sms-ingest.sh
#   (auto-loads FINDASH_WEBHOOK_TOKEN from .env.local)
#
# Or pass the token explicitly:
#   FINDASH_WEBHOOK_TOKEN=xxx ./scripts/test-sms-ingest.sh
#
# Requires the dev server running (`bun run dev`).

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${FINDASH_WEBHOOK_TOKEN:-}" && -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${FINDASH_WEBHOOK_TOKEN:?Set FINDASH_WEBHOOK_TOKEN (in .env.local or exported)}"
HOST="${HOST:-http://localhost:3100}"

post() {
  local label="$1"
  local sender="$2"
  local body="$3"
  echo "==> $label"
  local payload
  payload=$(jq -n --arg sender "$sender" --arg body "$body" \
    '{sender: $sender, body: $body}')
  curl -sS -X POST "$HOST/api/ingest/sms" \
    -H "Authorization: Bearer $FINDASH_WEBHOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" | jq .
  printf '\n'
}

post "COP purchase (Visa *2575)" "85784" \
  "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca."

post "USD purchase (Mastercard *7291 USD)" "85540" \
  "Bancolombia: Compraste USD195,26 en CLAUDE.AI SUBSCRIPTI, el 15/04/2026 a las 01:09. Esta compra esta asociada a T.Cred *7291. Si tienes dudas, encuentranos aqui: 01800931987. Siempre contigo."

post "QR payment from *6126" "87400" \
  "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste \$92,000.00 por codigo QR desde tu cuenta *6126 a la llave 0091498581 el 15/04/2026 a las 00:20. Con codigo QR es facil y de una. Dudas al 018000912345"

post "Transfer received" "85540" \
  "Bancolombia: ALEJANDRO, recibiste una transferencia de ESTEBAN LEONARDO SARMIENTO GOMEZ por \$100,000.00 en tu cuenta *6126 conectada a la llave 3012998429 el 14/04/26 a las 15:28. Con llaves es de una y gratis. Dudas al 018000912345"

post "TC payment (pago-tc)" "85784" \
  "Bancolombia: Pagaste \$1,320,564 en la tarjeta de credito *7291 desde la cuenta *6126, el 14/04/2026 21:48. ¿Dudas? Llamanos al 018000912345. Estamos cerca."

post "Failed purchase (should skip)" "85540" \
  "Bancolombia: tu compra con T.cred *2575 por \$92.000,00 no fue exitosa, los datos de tu t.cred estan incorrectos. 09:05 13/04/2026. ¿Dudas? 018000912345"

post "Auth notification (should skip)" "85540" \
  "Bancolombia: Listo. Actualizaste tu informacion personal en Sucursal Virtual, el 15/04/2026 a las 16:25."

post "Unknown format (should skip)" "85540" \
  "Bancolombia: promocion especial solo por hoy compralo ya no pagues el doble"

post "Idempotency check (same as first — should duplicate)" "85784" \
  "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca."

echo "==> Resulting transactions in DB:"
psql -d findash -c "
  SELECT t.id, a.name AS account, t.amount_cents, t.currency, t.category_slug, t.classification_method, t.merchant, t.description_raw
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE t.source = 'sms'
  ORDER BY t.id DESC
  LIMIT 10;
"

echo "==> Latest ingestion_logs entries for source='sms':"
psql -d findash -c "
  SELECT id, status, items_inserted, items_duplicated, error_message
  FROM ingestion_logs
  WHERE source = 'sms'
  ORDER BY id DESC
  LIMIT 10;
"
