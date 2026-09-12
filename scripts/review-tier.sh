#!/usr/bin/env bash
#
# review-tier.sh — the reviewer model for a branch, plus why its diff is risky.
#
# #922 shipped the risk rule as prose in .claude/skills/findash-orchestration:
# "Raise the reviewer for diffs touching money, schema, or a tenant boundary."
# Nothing executed it. The orchestrator had to remember, and on #511 it nearly
# did not: the cheap reviewer returned APPROVE on a diff that reopened incident
# #498, and the CRITICAL only surfaced because a second reviewer was run on a
# hunch. A rule that depends on someone remembering is not a gate — so this
# script still computes and prints the reasons below, even though (#935) they
# no longer select a second model.
#
# Every model here is NON-PREMIUM on purpose. DevPass meters premium models
# ($5+/M in or $15+/M out) against a separate ~$10.44/week cap.
#
# `gpt-6-astra` was the first high tier and is gone (#930): it was the first
# reviewer to catch the CRITICALs on #511, twice; `gemini-3.8-flash` later
# matched that catch at non-premium price, so that was still a real loss.
# `muse-spark-1.3` was the second (#930/#933) and is gone too (#935): measured
# against `deepseek-v4.1-flash` on the same #511 diff, it cost 4x more and
# returned 0 WARNINGs where that reviewer returned 3 — two of them real. The
# replacement `gemini-3.8-flash` is the only non-premium model that also caught
# the known migration CRITICAL, while catching the tenant-safety and sequencing
# warnings that only `claude-opus-5` had seen.
#
# One reviewer, `gemini-3.8-flash`, for every diff.
#
# Usage:
#   scripts/review-tier.sh                 # human-readable plan + any reasons
#   scripts/review-tier.sh --models        # the reviewer model id, for scripting
#   scripts/review-tier.sh --base <ref>    # compare against something else
#
# Exit: 0 always classified (reasons or not), 1 usage/classification error.
#
set -uo pipefail

trap 'printf "review-tier.sh failed to classify — read the diff manually.\\n" >&2; printf "%s\\n" "llmgateway/gemini-3.8-flash"; exit 1' ERR

readonly MODEL="llmgateway/gemini-3.8-flash"

base="origin/main"
models_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models) models_only=1; shift ;;
    --base)   base="${2:?--base needs a ref}"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 1 ;;
  esac
done

fail() {
  printf 'review-tier.sh: %s.\n' "$1" >&2
  printf '%s\n' "$MODEL"
  exit 1
}

git rev-parse --verify -q "$base" >/dev/null 2>&1 || git fetch --quiet origin main 2>/dev/null || true
git rev-parse --verify -q "$base" >/dev/null 2>&1 || fail "cannot resolve base ref '$base'"

# An empty diff and a failed diff look identical downstream. They must not be
# treated identically: one is "nothing to review", the other is "I do not know".
if ! files="$(git diff --name-only "${base}...HEAD" 2>/dev/null)"; then
  fail "git diff against '$base' failed"
fi

if [[ -z "$files" ]]; then
  (( models_only )) && printf '%s\n' "$MODEL"
  (( models_only )) || printf 'No diff against %s — nothing to review.\n' "$base"
  exit 0
fi

# Each rule is a reason, not just a pattern: the message is what the orchestrator
# shows a human as the flag for a careful read.
#
# Matching is pure bash on purpose. An earlier draft used `rg`, which is not on
# PATH in every shell a lane runs in — it failed silently and returned STANDARD
# for the #511 diff, the one carrying the CRITICAL. A tier script that fails
# open is worse than none, because it answers confidently.
reasons=()
match() {
  local pattern="$1" reason="$2" f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      $pattern) reasons+=("$reason"); return 0 ;;
    esac
  done <<< "$files"
  return 0
}

match 'drizzle/*'                  'migration — irreversible against production data'
match 'src/lib/db/schema.ts'       'schema definition'
match 'src/lib/reset/*'            'reset — data loss surface'
match 'src/lib/snapshots/*'        'snapshot/restore — data loss surface'
match 'src/lib/auth/*'             'auth boundary'
match 'src/proxy.ts'               'auth boundary'

# Content-level risks: a filename cannot tell you a diff touches money or a
# tenant column, so look at the added lines.
added="$(git diff "${base}...HEAD" -- '*.ts' '*.tsx' '*.sql' 2>/dev/null | grep '^+' || true)"
case "$added" in
  *amount_cents*|*amountCents*|*balanceCents*|*interes*)
    reasons+=('money — added lines touch amounts or interest') ;;
esac
case "$added" in
  *user_id*|*userId*)
    reasons+=('tenant boundary — added lines touch user scoping (#336, #338)') ;;
esac

if (( models_only )); then
  printf '%s\n' "$MODEL"
  exit 0
fi

if (( ${#reasons[@]} == 0 )); then
  printf 'Reviewer: %s\n\n%s file(s), none on a high-risk surface.\n' \
    "$MODEL" "$(wc -l <<< "$files" | tr -d ' ')"
  exit 0
fi

printf 'Reviewer: %s\n\n' "$MODEL"
printf 'This diff is on a high-risk surface — read the findings carefully:\n'
printf '  - %s\n' "${reasons[@]}"
exit 0
