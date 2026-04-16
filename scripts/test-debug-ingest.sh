#!/usr/bin/env bash
# Smoke test for POST /api/ingest/debug.
#
# Usage (recommended):
#   ./scripts/test-debug-ingest.sh
#   (auto-loads INGEST_WEBHOOK_TOKEN from .env.local)
#
# Or pass the token explicitly:
#   INGEST_WEBHOOK_TOKEN=xxx ./scripts/test-debug-ingest.sh
#   HOST=http://localhost:3100 INGEST_WEBHOOK_TOKEN=xxx ./scripts/test-debug-ingest.sh
#
# Requires the dev server running (`bun run dev`).

set -euo pipefail

# Run from project root so .env.local is found reliably.
cd "$(dirname "$0")/.."

# Auto-load .env.local if the token is not already exported in the environment.
# `set -a` auto-exports every variable assigned while it's on — the classic
# idiom for sourcing an env file into the current shell.
if [[ -z "${INGEST_WEBHOOK_TOKEN:-}" && -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${INGEST_WEBHOOK_TOKEN:?Set INGEST_WEBHOOK_TOKEN (in .env.local or exported in shell)}"

HOST="${HOST:-http://localhost:3100}"

echo "==> POST JSON with valid bearer token (expect 200 + logId)"
curl -sS -i -X POST "$HOST/api/ingest/debug" \
  -H "Authorization: Bearer $INGEST_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"test":"smoke","merchant":"CURL SMOKE TEST","amount":"1000","card":"Visa ···· 1234"}'
printf '\n\n'

echo "==> POST form-urlencoded (expect 200 + logId)"
curl -sS -i -X POST "$HOST/api/ingest/debug" \
  -H "Authorization: Bearer $INGEST_WEBHOOK_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'merchant=STARBUCKS&amount=14500&card=Mastercard+9876'
printf '\n\n'

echo "==> POST with wrong token (expect 401)"
curl -sS -i -X POST "$HOST/api/ingest/debug" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{}'
printf '\n\n'

echo "==> POST with no auth (expect 401)"
curl -sS -i -X POST "$HOST/api/ingest/debug" \
  -H "Content-Type: application/json" \
  -d '{}'
printf '\n\n'

echo "==> Latest 3 debug captures from ingestion_logs:"
psql -d findash -c "
  SELECT id,
         started_at,
         payload->>'contentType'  AS content_type,
         payload->'bodyParsed'    AS body
  FROM ingestion_logs
  WHERE status = 'debug'
  ORDER BY id DESC
  LIMIT 3;
"
