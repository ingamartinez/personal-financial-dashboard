#!/usr/bin/env bash
# findash-backup.sh — daily local pg_dump + weekly R2 off-site sync.
#
# Designed to run as the `findash` OS user (peer-auth to PostgreSQL).
# Install path (managed by bootstrap.sh): /usr/local/bin/findash-backup.sh
# Scheduled via: /etc/cron.d/findash-backup
#
# Local retention: 14 most recent daily dumps under /srv/findash/backups/daily/
# R2 retention:    12 most recent dumps under s3://$R2_BUCKET/findash/
#
# R2 credentials are read from /srv/findash/env/r2.env. If that file is
# missing the R2 sync is skipped with a warning — local backup still runs.
#
# Usage:
#   sudo -u findash /usr/local/bin/findash-backup.sh          # normal cron run
#   sudo -u findash /usr/local/bin/findash-backup.sh --force-r2  # skip DOW check, run R2 sync
#
set -euo pipefail

BACKUP_DIR="/srv/findash/backups/daily"
LOG_FILE="/srv/findash/logs/backup.log"
R2_ENV="/srv/findash/env/r2.env"
TIMESTAMP="$(date +%Y%m%dT%H%M)"
DUMP_FILE="$BACKUP_DIR/findash-${TIMESTAMP}.sql.gz"
LOCAL_KEEP=14
R2_KEEP=12
FORCE_R2="${1:-}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
if [[ "$(id -un)" != "findash" ]]; then
  printf 'ERROR: must run as findash user (current: %s)\n' "$(id -un)" >&2
  exit 1
fi

install -d -m 0750 "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# Daily local dump
# ---------------------------------------------------------------------------
log "backup: starting dump to $DUMP_FILE"
if pg_dump findash | gzip -9 >"$DUMP_FILE"; then
  SIZE="$(du -sh "$DUMP_FILE" | cut -f1)"
  log "backup: dump complete — $SIZE"
else
  log "ERROR: pg_dump failed — aborting"
  exit 1
fi

# Prune to LOCAL_KEEP most recent dumps
log "backup: pruning local backups (keep $LOCAL_KEEP)"
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/findash-*.sql.gz 2>/dev/null | tail -n +$((LOCAL_KEEP + 1)) | while read -r old; do
  rm -f "$old"
  log "backup: pruned local $old"
done

# ---------------------------------------------------------------------------
# Weekly R2 sync (Sundays, or when --force-r2 passed)
# ---------------------------------------------------------------------------
DOW="$(date +%u)"  # 1=Mon … 7=Sun
if [[ "$FORCE_R2" != "--force-r2" && "$DOW" != "7" ]]; then
  log "backup: skipping R2 sync (not Sunday, DOW=$DOW)"
  exit 0
fi

if [[ ! -f "$R2_ENV" ]]; then
  log "WARNING: $R2_ENV not found — skipping R2 sync (local backup is complete)"
  exit 0
fi

# Source R2 creds (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)
# shellcheck source=/dev/null
. "$R2_ENV"

if [[ -z "${R2_ACCOUNT_ID:-}" || -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" || -z "${R2_BUCKET:-}" ]]; then
  log "WARNING: R2 credentials incomplete in $R2_ENV — skipping R2 sync"
  exit 0
fi

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
R2_PREFIX="s3://${R2_BUCKET}/findash/"

log "backup: syncing $BACKUP_DIR to $R2_PREFIX"
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$R2_ENDPOINT" \
    s3 sync "$BACKUP_DIR/" "$R2_PREFIX" \
    --no-progress \
    --exclude "*" \
    --include "findash-*.sql.gz" 2>&1 | tee -a "$LOG_FILE"

log "backup: R2 sync complete"

# Prune R2 to R2_KEEP most recent
log "backup: pruning R2 backups (keep $R2_KEEP)"
R2_LIST=$(
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    aws --endpoint-url "$R2_ENDPOINT" \
      s3 ls "$R2_PREFIX" \
      --no-paginate 2>/dev/null \
    | awk '{print $4}' \
    | sort
)
TOTAL=$(printf '%s\n' "$R2_LIST" | wc -l)
if [[ "$TOTAL" -gt "$R2_KEEP" ]]; then
  TO_DELETE=$(printf '%s\n' "$R2_LIST" | head -n $(( TOTAL - R2_KEEP )))
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
      aws --endpoint-url "$R2_ENDPOINT" \
        s3 rm "${R2_PREFIX}${key}" 2>&1 | tee -a "$LOG_FILE"
    log "backup: pruned R2 ${R2_PREFIX}${key}"
  done <<<"$TO_DELETE"
fi

log "backup: done"
