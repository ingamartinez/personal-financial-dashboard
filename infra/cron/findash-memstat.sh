#!/usr/bin/env bash
# findash-memstat.sh — sample findash.service cgroup memory counters to a TSV.
#
# Designed to run as the `findash` OS user (all cgroup v2 memory.* files under
# /sys/fs/cgroup are 0444, so no privileges are needed to read them).
# Install path (managed by bootstrap.sh): /usr/local/bin/findash-memstat.sh
# Scheduled via: /etc/cron.d/findash-memstat
#
# Usage:
#   /usr/local/bin/findash-memstat.sh            # append one sample (cron)
#   /usr/local/bin/findash-memstat.sh --report   # summarise the log
#
# ---------------------------------------------------------------------------
# WHY THIS IS A CRON SCRIPT AND NOT A BullMQ WORKER (#800)
# ---------------------------------------------------------------------------
# AGENTS.md requires application background work to go through src/lib/queue.
# This is deliberately not that: it is host instrumentation, in the same
# category as findash-backup.sh, and it must keep sampling exactly when
# findash is unhealthy — throttled, swapping, or OOM-killed. A worker running
# inside the process being measured dies with it and loses the only samples
# that matter. Same reason it does not use the Pino logger.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS AT ALL (#800)
# ---------------------------------------------------------------------------
# #796 sized MemoryHigh=640M / MemoryMax=768M on a memory.peak of 763 MiB
# observed over ~2.5 days of uptime. findash restarted on the next deploy,
# which recreated the cgroup and reset memory.peak. That evidence is gone and
# is not reproducible.
#
# Two properties of the kernel interface make "just wait and read memory.peak"
# unworkable here, which is why this samples continuously instead:
#
#   1. memory.peak resets on every restart, and CD restarts findash on every
#      deploy. On an actively developed repo there is no 2-3 day deploy-free
#      window to wait for.
#   2. memory.peak is CENSORED once MemoryHigh is set. The brake reclaims
#      before the charge can grow past it, so the counter pins just above
#      memory.high and stays there no matter what the true demand is. On this
#      droplet it read 671346688 — 252 KiB above the 640 MiB brake — within
#      minutes of a clean start. Reading it after three days would report the
#      same number and answer nothing.
#      (memory.peak is also read-only on kernel 6.8, so it cannot be reset to
#      take a fresh high-water mark. Writable resets landed in 6.12.)
#
# So the load-bearing signals are NOT the peak. They are:
#
#   events_high     cumulative count of MemoryHigh throttle events. Rising =
#                   the brake is actively engaged. This is the number that
#                   answers "is 640M throttling normal operation, or only
#                   catching outliers". Compare against photoshowcase, which
#                   sits at 0.
#   pressure_full   cumulative microseconds where ALL tasks in the cgroup
#                   stalled on memory. This is the cost of the brake. High
#                   events with flat pressure_full = cheap page-cache
#                   reclaim; both rising together = real thrashing.
#   refault_anon    anon pages pushed to swap and faulted back in. Not free.
#   events_max      MemoryMax hits, and oom_kill. Both must stay 0.
#
# The `generation` column is the unit's ActiveEnterTimestamp. Counters are
# only comparable within one generation — they all reset when it changes.
# --report groups by it so a restart cannot silently corrupt a trend.
set -euo pipefail

CGROUP="/sys/fs/cgroup/system.slice/findash.service"
LOG_FILE="/srv/findash/logs/memstat.tsv"
# 5-minute cadence: 288 rows/day. 8640 rows keeps ~30 days at roughly 2 MB.
MAX_ROWS=8640

read_kv() { awk -v k="$2" '$1 == k { print $2; exit }' "$1" 2>/dev/null || true; }
read_pressure() {
  # "some avg10=0.00 ... total=1221262" -> the total field only.
  awk -v pfx="$2" '$1 == pfx { for (i = 2; i <= NF; i++) if ($i ~ /^total=/) { sub(/^total=/, "", $i); print $i; exit } }' "$1" 2>/dev/null || true
}

report() {
  [ -f "$LOG_FILE" ] || { echo "no samples yet at $LOG_FILE"; exit 0; }
  echo "findash memory samples — grouped by cgroup generation (counters reset per generation)"
  echo
  awk -F'\t' '
    NR == 1 { next }
    {
      g = $2
      if (!(g in n)) { order[++k] = g; first[g] = $1 }
      n[g]++; last[g] = $1
      if ($4 + 0 > cur_max[g]) cur_max[g] = $4 + 0
      peak[g] = $5 + 0; swap[g] = $6 + 0
      hi[g] = $8 + 0; mx[g] = $9 + 0; ok[g] = $10 + 0
      pfull[g] = $12 + 0; refa[g] = $13 + 0
    }
    END {
      for (i = 1; i <= k; i++) {
        g = order[i]
        printf "generation %s  (%d samples, %s -> %s)\n", g, n[g], first[g], last[g]
        printf "  max memory.current   %8.1f MiB\n", cur_max[g] / 1048576
        printf "  memory.peak          %8.1f MiB  (censored by MemoryHigh — see script header)\n", peak[g] / 1048576
        printf "  swap at last sample  %8.1f MiB\n", swap[g] / 1048576
        printf "  events high          %8d      <- rising means the brake is engaged\n", hi[g]
        printf "  events max           %8d      <- must stay 0\n", mx[g]
        printf "  oom_kill             %8d      <- must stay 0\n", ok[g]
        printf "  pressure full total  %8.2f s    <- cost of the brake\n", pfull[g] / 1000000
        printf "  refault_anon         %8d      <- swapped out then needed again\n", refa[g]
        printf "\n"
      }
    }
  ' "$LOG_FILE"
}

[ "${1:-}" = "--report" ] && { report; exit 0; }

[ -d "$CGROUP" ] || { echo "findash-memstat: $CGROUP absent (service down?)" >&2; exit 0; }

generation=$(systemctl show findash.service -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo "unknown")
events="$CGROUP/memory.events"
stat="$CGROUP/memory.stat"

row=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$generation" \
  "$(read_kv "$stat" anon)" \
  "$(cat "$CGROUP/memory.current")" \
  "$(cat "$CGROUP/memory.peak")" \
  "$(cat "$CGROUP/memory.swap.current")" \
  "$(read_kv "$stat" file)" \
  "$(read_kv "$events" high)" \
  "$(read_kv "$events" max)" \
  "$(read_kv "$events" oom_kill)" \
  "$(read_pressure "$CGROUP/memory.pressure" some)" \
  "$(read_pressure "$CGROUP/memory.pressure" full)" \
  "$(read_kv "$stat" workingset_refault_anon)" \
  "$(read_kv "$stat" pgmajfault)")

if [ ! -f "$LOG_FILE" ]; then
  printf 'ts\tgeneration\tanon\tcurrent\tpeak\tswap\tfile\tevents_high\tevents_max\toom_kill\tpressure_some_total\tpressure_full_total\trefault_anon\tpgmajfault\n' > "$LOG_FILE"
  chmod 0640 "$LOG_FILE"
fi
printf '%s\n' "$row" >> "$LOG_FILE"

# Self-trim so this never needs a logrotate entry. Header is always kept.
lines=$(wc -l < "$LOG_FILE")
if [ "$lines" -gt "$((MAX_ROWS + 1))" ]; then
  tmp=$(mktemp "${LOG_FILE}.XXXXXX")
  { head -n 1 "$LOG_FILE"; tail -n "$MAX_ROWS" "$LOG_FILE"; } > "$tmp"
  chmod 0640 "$tmp"
  mv "$tmp" "$LOG_FILE"
fi
