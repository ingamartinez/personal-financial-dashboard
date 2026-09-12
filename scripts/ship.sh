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
# Merging is gated, not manual. `--merge` squash-merges only when the AGENTS.md
# auto-merge conditions hold (CI green, PR closes a single issue, mergeable).
# The check lives here rather than in an agent's permission list because a
# permission cannot read CI status: it can only allow the command and hope.
# Without --merge the script still stops at the report, as it always did.
#
# This script also owns the "a human is needed" report (#953). `lane.sh start`
# opens an interactive session and only regains control when the human quits,
# possibly hours after the run ended — this is the code that learns CI went red
# or that the merge was refused, at the moment it learns it. It comments on the
# issue and fires a best-effort desktop notification. A green merge says
# nothing: silence is the success report.
#
# Usage:
#   scripts/ship.sh                       # infer everything from the branch
#   scripts/ship.sh --issue 912           # force the issue number
#   scripts/ship.sh --part-of             # `Part of #N` instead of `Closes #N`
#   scripts/ship.sh --closes              # force `Closes #N` on an epic issue
#   scripts/ship.sh --body-file notes.md  # use this as the PR body
#   scripts/ship.sh --no-test             # skip the suite (parallel lanes)
#   scripts/ship.sh --no-watch            # open the PR, do not wait for CI
#   scripts/ship.sh --merge               # squash-merge if the auto-merge conditions hold
#   scripts/ship.sh --no-report           # print failures, do not comment on the issue
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

# ------------------------------------------------------------------ reporting
#
# GitHub is source of truth #1 in AGENTS.md: the comment is durable, it notifies
# on its own, and it reads the same on the Mac and on ia-server. The desktop
# notification is a courtesy on top and best-effort by definition — a missing
# notifier is a silent no-op, a broken one is swallowed. Neither may fail the
# run, and neither may come before the issue comment.

# AppleScript string literals take double quotes and backslash escapes.
osa_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

notify() {
  local title="$1" body="$2" os
  os="$(uname -s 2>/dev/null || printf 'unknown')"
  case "$os" in
    Darwin)
      command -v osascript >/dev/null 2>&1 || return 0
      osascript -e "display notification \"$(osa_escape "$body")\" with title \"$(osa_escape "$title")\"" \
        >/dev/null 2>&1 || true
      ;;
    Linux)
      command -v notify-send >/dev/null 2>&1 || return 0
      notify-send "$title" "$body" >/dev/null 2>&1 || true
      ;;
  esac
  return 0
}

# report <headline> [markdown detail line ...]
# Called on the paths a human has to look at, never on a clean merge.
report() {
  local headline="$1"; shift
  (( report_failures )) || return 0
  [[ -n "$issue" ]] || return 0

  if printf '%s\n' "**$headline**" "" "$@" \
    | gh_ issue comment "$issue" --body-file - >/dev/null; then
    info "reported on #$issue"
  else
    warn "could not comment on #$issue — the report above is the only copy"
  fi

  notify "findash #$issue" "$headline"
  return 0
}

issue=""
link_word="Closes"
link_explicit=0
# Set only when pre-flight had to GUESS which issue this PR belongs to.
# That, not the link word, is the ambiguity AGENTS.md condition (b) is about.
multi_issue=0
body_file=""
run_tests=1
watch_ci=1
dry_run=0
merge_pr=0
report_failures=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)     issue="${2:?--issue needs a number}"; shift 2 ;;
    --part-of)   link_word="Part of"; link_explicit=1; shift ;;
    --closes)    link_word="Closes";  link_explicit=1; shift ;;
    --body-file) body_file="${2:?--body-file needs a path}"; shift 2 ;;
    --no-test)   run_tests=0; shift ;;
    --no-watch)  watch_ci=0; shift ;;
    --merge)     merge_pr=1; shift ;;
    --no-report) report_failures=0; shift ;;
    --dry-run)   dry_run=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown flag: $1" ;;
  esac
done

(( merge_pr && ! watch_ci )) && die "--merge needs the CI watch; drop --no-watch"

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
       multi_issue=1
       warn "commits reference issues: ${issues[*]} — using #$issue with 'Part of'" ;;
  esac
fi
info "issue: #$issue ($link_word)"

gh_ api "repos/$REPO/issues/$issue" >/dev/null 2>&1 || die "issue #$issue does not exist"

# An epic closed by its first phase dies with the remaining phases unwritten.
#
# Counting `- [ ]` boxes in the body could not tell an epic's phase list apart
# from an ordinary Acceptance section, and findash issues carry four or five
# acceptance criteria as a matter of course: the guard fired on every ship of
# the #948→#966 run and every one of them answered `--closes` (#970). A guard
# that is always wrong is a guard nobody reads.
#
# The repo already marks the real thing with the `epic` label (#776, #254).
# Labelling is a deliberate act about what the issue IS; a checklist is
# punctuation. The cost is an unlabelled epic slipping through on `Closes` —
# cheaper than the alternative, which was teaching every author to wave the
# guard away by reflex.
if (( ! link_explicit )); then
  is_epic=0
  while IFS= read -r label; do
    [[ "$label" == "epic" ]] && is_epic=1
  done < <(gh_ api "repos/$REPO/issues/$issue" --jq '.labels[].name' 2>/dev/null || true)
  if (( is_epic )); then
    die "issue #$issue is labelled 'epic' — closing it with this PR buries the phases that are left.
     Pass --part-of (usual) or --closes (this PR really finishes it)."
  fi
fi

if (( multi_issue )); then
  info "auto-merge conditions will NOT hold (commits reference several issues)"
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

pr_url="$(gh_ api "repos/$REPO/pulls?head=$GH_USER:$branch&state=all" \
  --jq '.[0].html_url // ""' 2>/dev/null || true)"

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

# `gh pr checks --watch` does NOT wait for checks to be created. When GitHub has
# not yet registered a check run for the head commit it prints "no checks
# reported" and exits non-zero immediately — a few-second race that reports a
# perfectly green branch as RED, and under --merge silently skips the merge.
# Wait for the first check to exist before watching.
appear_timeout=180
waited=0
while :; do
  checks_out="$(gh_ pr checks "$pr_number" 2>&1)" && break
  [[ "$checks_out" != *"no checks reported"* ]] && break
  if (( waited >= appear_timeout )); then
    report "No CI checks appeared on \`$branch\` after ${appear_timeout}s." \
      "- PR: $pr_url" \
      "- Is \`.github/workflows/ci.yml\` triggered for this branch?" \
      "- The PR stays open and the lane stays as it is."
    die "no checks appeared on $branch after ${appear_timeout}s
     Is .github/workflows/ci.yml triggered for this branch? PR: $pr_url"
  fi
  sleep 5
  waited=$(( waited + 5 ))
done
(( waited > 0 )) && info "checks registered after ${waited}s"

ci_status=0
gh_ pr checks "$pr_number" --watch --interval 20 || ci_status=$?

step "Result"
gh_ pr checks "$pr_number" || true

if (( ci_status != 0 )); then
  printf '\n  PR:    %s\n  CI:    %sRED%s\n  Merge: blocked\n\n' "$pr_url" "$c_red" "$c_off"
  report "CI is red on \`$branch\` — the PR stays open and nothing merged." \
    "- PR: $pr_url" \
    "$(gh_ pr checks "$pr_number" --json name,bucket,link --jq \
        '.[] | select(.bucket == "fail") | "- Failing: `" + .name + "` " + .link' \
        2>/dev/null || true)" \
    "" \
    "Fix it on the branch and push again — the lane is still there." \
    "Resume with \`scripts/lane.sh start --issue $issue\`."
  die "CI failed — the PR stays open. Fix it on the branch and push again."
fi

# GitHub computes mergeability asynchronously and answers UNKNOWN until it is
# done — which it always is right after a push, and again whenever main moves
# under the PR. Reading it once treats "not computed yet" as "not mergeable"
# and silently skips the merge. Same family as the CI-checks race above: ask
# GitHub for a fact it has not derived yet and you get a confident wrong answer.
mergeable="UNKNOWN"
waited=0
while (( waited < 90 )); do
  mergeable="$(gh_ api "repos/$REPO/pulls/$pr_number" \
    --jq 'if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end')"
  [[ "$mergeable" != "UNKNOWN" ]] && break
  sleep 5
  waited=$(( waited + 5 ))
done
(( waited > 0 )) && info "mergeability settled after ${waited}s"
[[ "$mergeable" == "UNKNOWN" ]] && warn "GitHub still reports UNKNOWN after ${waited}s"
# AGENTS.md condition (b) is "the PR closes a single issue" — a statement about
# SCOPE, not about the link word. `Part of` is the correct word for one phase of
# an epic and closes nothing, so it cannot orphan the remaining phases; refusing
# it punished authors for choosing the safe word (#964). What genuinely has
# ambiguous scope is a PR whose commits name several issues, where pre-flight
# picked one by guessing — that is what `multi_issue` marks.
auto_ok="no"
(( ! multi_issue )) && [[ "$mergeable" == "MERGEABLE" ]] && auto_ok="yes"

printf '\n  PR:         %s\n  CI:         %sGREEN%s\n  Mergeable:  %s\n  Auto-merge: %s\n' \
  "$pr_url" "$c_grn" "$c_off" "$mergeable" "$auto_ok"

if [[ "$auto_ok" != "yes" ]]; then
  if (( multi_issue )); then
    reason="commits reference several issues — scope is ambiguous"
  else
    reason="not mergeable: $mergeable"
  fi
  printf '\n  Auto-merge conditions do NOT hold (%s) — a human decides.\n\n' "$reason"
  # Only a refused --merge is a report: without it, stopping at PR-open is the
  # documented outcome, not a surprise anybody needs waking up for.
  if (( merge_pr )); then
    report "Merge refused on \`$branch\` — CI is green but a human decides." \
      "- PR: $pr_url" \
      "- Reason: $reason" \
      "" \
      "The PR stays open and the lane stays as it is." \
      "Resume with \`scripts/lane.sh start --issue $issue\`."
    die "refusing to merge: $reason"
  fi
  exit 0
fi

if (( ! merge_pr )); then
  printf '\n  AGENTS.md auto-merge conditions hold. To merge:\n    scripts/ship.sh --merge\n\n'
  exit 0
fi

step "Merge"
if ! gh_ pr merge "$pr_number" --squash --delete-branch; then
  report "Squash merge failed on \`$branch\` — CI was green, the merge call was not." \
    "- PR: $pr_url" \
    "" \
    "The PR stays open and the lane stays as it is." \
    "Resume with \`scripts/lane.sh start --issue $issue\`."
  die "merge failed — the PR stays open"
fi
info "squash-merged and deleted $branch on the remote"

# The local branch now tracks a ref that no longer exists. Land on a fresh main
# so the next lane does not branch off a stale base. This runs in bash, not in
# an agent's permission list, for the same reason the merge gate does.
#
# Non-fatal on purpose: in a worktree lane `main` is checked out in the primary
# checkout and git refuses a second one. The merge already happened; a failed
# cleanup must not report it as a failed ship. The lane gets torn down anyway.
step "Back to main"
local_state="main"
# `gh pr merge --delete-branch` already moves off the branch and deletes it
# locally, so both steps below are normally no-ops. Treat "already done" as
# success: a warning that fires on every clean run teaches whoever reads this
# output to skim past the real ones sitting next to it.
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || git checkout --quiet main 2>/dev/null; then
  git pull --quiet --ff-only origin main || warn "could not fast-forward main"
  if git show-ref --quiet --verify "refs/heads/$branch"; then
    git branch -D "$branch" >/dev/null 2>&1 || warn "local branch $branch kept"
  fi
  info "on main at $(git rev-parse --short HEAD)"
else
  local_state="$branch (worktree — main is checked out elsewhere)"
  warn "staying on $branch; remove this worktree to clean up"
fi

printf '\n  PR:     %s %sMERGED%s\n  Branch: deleted on remote\n  Local:  %s\n\n' \
  "$pr_url" "$c_grn" "$c_off" "$local_state"
