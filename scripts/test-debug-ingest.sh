#!/usr/bin/env bash
# Smoke test for POST /api/ingest/debug.
#
# Usage:
#   INGEST_WEBHOOK_TOKEN=xxx ./scripts/test-debug-ingest.sh
#   HOST=http://localhost:3100 INGEST_WEBHOOK_TOKEN=xxx ./scripts/test-debug-ingest.sh
#
# Requires the dev server running (`bun run dev`).

set -euo pipefail

HOST="${HOST:-http://localhost:3100}"
: "${INGEST_WEBHOOK_TOKEN:?Set INGEST_WEBHOOK_TOKEN (must match .env.local)}"

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
