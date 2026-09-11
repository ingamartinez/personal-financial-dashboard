#!/usr/bin/env bash
#
# ship.sh — take a finished branch to a green PR. Deterministic, no model.
#
# Replaces the findash-shipper agent (issue #922, task 5). Shipping is gates,
# push, PR and waiting for CI: every step has one correct answer, and the one
# that dominates wall-clock is waiting. A model cannot wait — that is why the
# agent needed the "poll `gh pr checks` inline, never ScheduleWakeup" workaround.
# `gh pr checks --watch` does it natively and for free.
#
# This script never merges. Merging stays a deliberate human action.
#
# Usage:
#   scripts/ship.sh                       # infer everything from the branch
#   scripts/ship.sh --issue 912           # force the issue number
#   scripts/ship.sh --part-of             # `Part of #N` instead of `Closes #N`
#   scripts/ship.sh --closes               # force `Closes #N` on a checklist issue
#   scripts/ship.sh --body-file notes.md  # use this as the PR body
#   scripts/ship.sh --no-test             # skip the suite (parallel lanes)
#   scripts/ship.sh --no-watch            # open the PR, do not wait for CI
#   scripts/ship.sh --dry-run             # run gates, print the plan, push nothing
#
set -euo pipefail

readonly GH_CFG="${HOME}/.config/gh-findash"
readonly GH_USER="ingamartinez"
readonly REPO="ingamartinez/personal-financial-dashboard"
readonly CONVENTIONAL='^(feat|fix|chore|refactor|test|docs|perf|style)(\([a-z0-9._/-]+\))?!?: .+'

gh_() { GH_CONFIG_DIR="$GH_CFG" gh "$@"; }

# Print the header comment block (everything between the shebang and `set -e`).
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$c_grn" "$c_off" "$*"; }
info() { printf '    %s%s%s\n' "$c_dim" "$*" "$c_off"; }
warn() { printf '%s !! %s%s\n' "$c_ylw" "$*" "$c_off"; }
die()  { printf '%s ✗  %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

issue=""
link_word="Closes"
link_explicit=0
body_file=""
run_tests=1
watch_ci=1
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)     issue="${2:?--issue needs a number}"; shift 2 ;;
    --part-of)   link_word="Part of"; link_explicit=1; shift ;;
    --closes)    link_word="Closes";  link_explicit=1; shift ;;
    --body-file) body_file="${2:?--body-file needs a path}"; shift 2 ;;
    --no-test)   run_tests=0; shift ;;
    --no-watch)  watch_ci=0; shift ;;
    --dry-run)   dry_run=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown flag: $1" ;;
  esac
done

# ---------------------------------------------------------------- pre-flight
step "Pre-flight"

command -v gh >/dev/null || die "gh is not installed"
[[ -d "$GH_CFG" ]] || die "missing $GH_CFG — see skill findash-github"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" != "main" ]] || die "refusing to ship from main"
info "branch: $branch"

# Only tracked changes block. Untracked files are normal in a working checkout
# (scratch notes, local statements, tool caches) and must not stop a ship.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  git status --short --untracked-files=no
  die "tracked files have uncommitted changes — commit or stash first"
fi

untracked="$(git ls-files --others --exclude-standard)"
if [[ -n "$untracked" ]]; then
  info "$(wc -l <<< "$untracked" | tr -d ' ') untracked file(s) — not shipped, not blocking"
fi

git fetch --quiet origin main
commits="$(git log origin/main..HEAD --pretty=%s)"
[[ -n "$commits" ]] || die "no commits on top of origin/main"

bad=0
while IFS= read -r subject; do
  if [[ ! "$subject" =~ $CONVENTIONAL ]]; then
    warn "non-conventional commit subject: $subject"
    bad=1
  fi
done <<< "$commits"
(( bad == 0 )) || die "fix the commit subjects before shipping (see AGENTS.md § Commit format)"
info "$(wc -l <<< "$commits" | tr -d ' ') commit(s), all conventional"

# Issue number: explicit flag, else the (#N) suffixes on the commits.
if [[ -z "$issue" ]]; then
  issues=()
  while IFS= read -r subject; do
    [[ "$subject" =~ \(#([0-9]+)\)[[:space:]]*$ ]] || continue
    found="${BASH_REMATCH[1]}"; seen=0
    for known in ${issues[@]+"${issues[@]}"}; do
      [[ "$known" == "$found" ]] && seen=1
    done
    (( seen )) || issues+=("$found")
  done <<< "$commits"
  case "${#issues[@]}" in
    0) die "no issue number found in any commit subject — pass --issue N" ;;
    1) issue="${issues[0]}" ;;
    *) issue="${issues[0]}"
       link_word="Part of"
       warn "commits reference issues: ${issues[*]} — using #$issue with 'Part of'" ;;
  esac
fi
info "issue: #$issue ($link_word)"

gh_ issue view "$issue" --json number >/dev/null 2>&1 || die "issue #$issue does not exist"

# An epic closed by its first phase dies with the remaining phases unwritten.
# A checklist in the issue body is the tell: make the caller say which it is.
if (( ! link_explicit )); then
  boxes="$(gh_ issue view "$issue" --json body --jq .body | awk '/^[[:space:]]*- \[[ xX]\]/ { n++ } END { print n + 0 }')"
  if (( boxes >= 3 )); then
    die "issue #$issue has $boxes checklist items — it looks like an epic.
     Pass --part-of (usual) or --closes (this PR really finishes it)."
  fi
fi

if [[ "$link_word" == "Part of" ]]; then
  info "auto-merge conditions will NOT hold (PR does not close a single issue)"
fi

# ---------------------------------------------------------------- gates
step "Quality gates"

info "lint"        && bun run lint
info "typecheck"   && bun run typecheck
info "format:check" && bun run format:check

if (( run_tests )); then
  if [[ -n "${FINDASH_TEST_DB:-}" ]]; then
    info "test (FINDASH_TEST_DB=$FINDASH_TEST_DB)"
  else
    info "test (shared findash_test — no other lane may be running)"
  fi
  bun run test
else
  warn "test suite skipped (--no-test); CI still runs it"
fi

# CI owns `next build`. Do not run it locally.

# ---------------------------------------------------------------- push
title="$(git log -1 --pretty=%s)"

if (( dry_run )); then
  step "Dry run — stopping before push"
  info "would push:   $branch"
  info "would title:  $title"
  info "would link:   $link_word #$issue"
  exit 0
fi

step "Push"
token="$(gh_ auth token --user "$GH_USER")" || die "could not read the $GH_USER token"
if ! git push --quiet "https://${GH_USER}:${token}@github.com/${REPO}.git" HEAD 2>&1; then
  die "push rejected — if it mentions the 'workflow' scope, run:
     GH_CONFIG_DIR=$GH_CFG gh auth refresh -h github.com -s workflow"
fi
info "pushed $branch"

# ---------------------------------------------------------------- PR
step "Pull request"

pr_url="$(gh_ pr view "$branch" --json url --jq .url 2>/dev/null || true)"

if [[ -n "$pr_url" ]]; then
  info "PR already open: $pr_url"
else
  tmp_body="$(mktemp)"
  trap 'rm -f "$tmp_body"' EXIT
  if [[ -n "$body_file" ]]; then
    [[ -f "$body_file" ]] || die "no such body file: $body_file"
    cat "$body_file" > "$tmp_body"
  else
    {
      printf '## What\n\n'
      git log origin/main..HEAD --pretty='- %s' | sed 's/ (#[0-9]*)$//'
      printf '\n## Verification\n\n- `bun run lint`\n- `bun run typecheck`\n- `bun run format:check`\n'
      (( run_tests )) && printf -- '- `bun run test`\n'
    } > "$tmp_body"
  fi
  printf '\n%s #%s\n' "$link_word" "$issue" >> "$tmp_body"

  pr_url="$(gh_ pr create --base main --head "$branch" --title "$title" --body-file "$tmp_body")"
  info "opened $pr_url"
fi

pr_number="${pr_url##*/}"

# ---------------------------------------------------------------- CI
if (( ! watch_ci )); then
  step "Done (--no-watch)"
  printf '\n  PR:    %s\n  CI:    not watched\n  Merge: manual\n\n' "$pr_url"
  exit 0
fi

step "Watching CI"
info "this blocks until every check reports — that is the point"

ci_status=0
gh_ pr checks "$pr_number" --watch --interval 20 || ci_status=$?

step "Result"
gh_ pr checks "$pr_number" || true

if (( ci_status != 0 )); then
  printf '\n  PR:    %s\n  CI:    %sRED%s\n  Merge: blocked\n\n' "$pr_url" "$c_red" "$c_off"
  die "CI failed — the PR stays open. Fix it on the branch and push again."
fi

mergeable="$(gh_ pr view "$pr_number" --json mergeable --jq .mergeable)"
auto_ok="no"
[[ "$link_word" == "Closes" && "$mergeable" == "MERGEABLE" ]] && auto_ok="yes"

printf '\n  PR:         %s\n  CI:         %sGREEN%s\n  Mergeable:  %s\n  Auto-merge: %s\n' \
  "$pr_url" "$c_grn" "$c_off" "$mergeable" "$auto_ok"

if [[ "$auto_ok" == "yes" ]]; then
  printf '\n  AGENTS.md auto-merge conditions hold. To merge:\n    GH_CONFIG_DIR=%s gh pr merge %s --squash --delete-branch\n\n' "$GH_CFG" "$pr_number"
else
  printf '\n  Auto-merge conditions do NOT hold (%s) — a human decides.\n\n' \
    "$([[ "$link_word" == "Part of" ]] && echo "PR does not close a single issue" || echo "not mergeable: $mergeable")"
fi
