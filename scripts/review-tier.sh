#!/usr/bin/env bash
#
# review-tier.sh — decide which reviewer(s) a branch needs, from its diff.
#
# #922 shipped this rule as prose in .claude/skills/findash-orchestration:
# "Raise the reviewer for diffs touching money, schema, or a tenant boundary."
# Nothing executed it. The orchestrator had to remember, and on #511 it nearly
# did not: the cheap reviewer returned APPROVE on a diff that reopened incident
# #498, and the CRITICAL only surfaced because a second reviewer was run on a
# hunch. A rule that depends on someone remembering is not a gate.
#
# Measured on that diff (#930), five reviewers, one known CRITICAL:
#   deepseek-v4-pro $0.04 APPROVE | muse-spark $0.23 APPROVE | kimi-k3 $0.45 APPROVE
#   gpt-6-astra     $1.13 CRITICAL ✅ | claude-opus-5 $1.97 APPROVE
# The most expensive model missed it. Two cheap reviewers of different lineage
# ($1.17) beat one expensive one ($1.97) on both cost and findings.
#
# Usage:
#   scripts/review-tier.sh                 # human-readable plan
#   scripts/review-tier.sh --models        # one model id per line, for scripting
#   scripts/review-tier.sh --base <ref>    # compare against something else
#
# Exit: 0 standard tier, 10 high tier, 1 usage error.
#
set -uo pipefail

# Fail CLOSED. Any unexpected error escalates to the high tier rather than
# letting a broken check wave a risky diff through on the cheap reviewer.
trap 'printf "review-tier.sh failed to classify — escalating to HIGH tier.\\n" >&2; printf "%s\\n%s\\n" "llmgateway/gpt-6-astra" "llmgateway/deepseek-v4-pro"; exit 10' ERR

readonly STANDARD="llmgateway/deepseek-v4-pro"
readonly HIGH_EXTRA="llmgateway/gpt-6-astra"

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

escalate() {
  printf 'review-tier.sh: %s — escalating to HIGH tier.\n' "$1" >&2
  printf '%s\n%s\n' "$HIGH_EXTRA" "$STANDARD"
  exit 10
}

git rev-parse --verify -q "$base" >/dev/null 2>&1 || git fetch --quiet origin main 2>/dev/null || true
git rev-parse --verify -q "$base" >/dev/null 2>&1 || escalate "cannot resolve base ref '$base'"

# An empty diff and a failed diff look identical downstream. They must not be
# treated identically: one is "nothing to review", the other is "I do not know".
if ! files="$(git diff --name-only "${base}...HEAD" 2>/dev/null)"; then
  escalate "git diff against '$base' failed"
fi

if [[ -z "$files" ]]; then
  (( models_only )) && printf '%s\n' "$STANDARD"
  (( models_only )) || printf 'No diff against %s — standard tier.\n' "$base"
  exit 0
fi

# Each rule is a reason, not just a pattern: the message is what the orchestrator
# shows a human when it escalates.
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

if (( ${#reasons[@]} == 0 )); then
  if (( models_only )); then
    printf '%s\n' "$STANDARD"
  else
    printf 'Standard tier — one reviewer.\n\n  %s\n\n%s file(s), none on a high-risk surface.\n' \
      "$STANDARD" "$(wc -l <<< "$files" | tr -d ' ')"
  fi
  exit 0
fi

if (( models_only )); then
  printf '%s\n%s\n' "$HIGH_EXTRA" "$STANDARD"
  exit 10
fi

printf 'HIGH tier — two reviewers, different lineage.\n\n'
printf '  %s\n  %s\n\n' "$HIGH_EXTRA" "$STANDARD"
printf 'Why:\n'
printf '  - %s\n' "${reasons[@]}"
printf '\nRun both and merge the findings. They do not see the same things: on #511\n'
printf 'astra alone caught the CRITICAL, and the pair costs less than one ceiling model.\n'
exit 10
