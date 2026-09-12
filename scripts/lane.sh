#!/usr/bin/env bash
#
# lane.sh — per-issue worktree lane: create it, tear it down, refuse to work
# without one. Deterministic, no model.
#
# #944 moved the three findash lanes in-process. In-process subagents inherit
# the parent cwd and opencode 1.18.30 exposes no per-subagent directory, so the
# unit of isolation is the ORCHESTRATOR PROCESS, not the lane: one orchestrator
# per issue, launched with its cwd inside that issue's worktree. Lanes within
# one issue run sequentially on one branch and correctly share a tree.
# Concurrent issues do not — that shared tree is the #739/#740 and #766/#772
# collision.
#
# #944 shipped that as prose and the primary checkout kept hosting lane
# branches anyway. Hence `check`: scripts get run, docs get skipped.
#
# A lane is four things, and a half-made one is worse than none:
#   worktree + branch   git, plain — herdr is no longer on this path
#   .env.local          gitignored; the lane fails at runtime without it
#   findash_test_<n>    with the UTC ALTER (skill findash-testing) — not optional
#   node_modules        not shared between worktrees
# `create` rolls back everything it made if any step fails. `remove` takes all
# four down, plus the per-worker clones and the shared-DB re-migration.
#
# `start` (#953) closes the loop: create-or-reuse the lane, open the
# orchestrator TUI with its cwd inside it, then tear the lane down or park it.
# Resuming is the same command, on purpose: a second verb for "continue" is a
# verb somebody has to remember.
#
# It launches the INTERACTIVE tui and passes no --prompt. The opening exchange
# is the point: the human hands over the issue and verifies the scope before
# anything is spent, which is where a badly scoped issue gets caught.
#
# Because of that, `start` only regains control when the human quits — possibly
# long after the run ended. So it reports nothing: `scripts/ship.sh` owns that,
# because it is what learns CI went red or the merge was refused at the moment
# it learns it, and that reaches a human who walked away. Post-exit here is
# teardown only: PR MERGED removes the lane, anything else keeps it.
#
# `start` with NO --issue (#956) is the talk mode: the orchestrator in the
# PRIMARY checkout, no lane, no teardown. Work does not always arrive as an
# issue number — it arrives as an idea that has to be scoped first, and the
# orchestrator can now open the issue itself once it is. Standing in the
# primary is safe because `check` already refuses an implementer there: talking
# in the primary breaks nothing, implementing does. One verb covers both modes.
#
# Usage:
#   scripts/lane.sh create --issue 949                  # slug + phase from the issue
#   scripts/lane.sh create --issue 949 --slug lane-iso  # force the slug
#   scripts/lane.sh create --issue 949 --phase 4 --agent claude --base origin/main
#   scripts/lane.sh start  --issue 953                  # lane + orchestrator + teardown
#   scripts/lane.sh start  --issue 953 --dry-run        # print the launch line and the decision
#   scripts/lane.sh start  --issue 953 --no-auto        # approve each permission by hand
#   scripts/lane.sh start  --issue 953 -m provider/model  # override the orchestrator model
#   scripts/lane.sh start                               # talk mode: primary checkout, no lane
#   scripts/lane.sh start  --dry-run                    # print the talk-mode launch line
#   scripts/lane.sh remove --issue 949                  # worktree, branch, DB, directory
#   scripts/lane.sh remove --issue 949 --force          # even with unmerged commits
#   scripts/lane.sh remove --issue 949 --kill-procs     # also kill sessions pointed at it
#   scripts/lane.sh check                               # am I in a lane? exit 1 if not
#
set -euo pipefail

readonly GH_CFG="${HOME}/.config/gh-findash"
readonly DB_PREFIX="findash_test"

gh_() { GH_CONFIG_DIR="$GH_CFG" gh "$@"; }
psql_() { psql -d postgres -Atc "$1"; }

# Print the header comment block (everything between the shebang and `set -e`).
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$c_grn" "$c_off" "$*"; }
info() { printf '    %s%s%s\n' "$c_dim" "$*" "$c_off"; }
warn() { printf '%s !! %s%s\n' "$c_ylw" "$*" "$c_off"; }
die()  { printf '%s ✗  %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# --------------------------------------------------------------------- shared

# The primary checkout, from anywhere: --git-common-dir points at the real .git
# from inside a linked worktree, where --show-toplevel would answer the lane.
primary_root() {
  local common
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "not inside a git repository"
  dirname "$common"
}

slugify() {
  local s
  s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/([^)]*)//g' -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//')"
  # Shorten on a word boundary: a branch cut mid-word reads as a typo.
  while (( ${#s} > 40 )) && [[ "$s" == *-* ]]; do s="${s%-*}"; done
  printf '%s' "${s:0:40}"
}

# Every database the lane owns: the base, plus the `_wN` clones
# vitest.global-setup.ts leaves behind when a run is killed mid-flight.
lane_databases() {
  local base="$1" name
  while IFS= read -r name; do
    case "$name" in "$base" | "${base}"_w*) printf '%s\n' "$name" ;; esac
  done < <(psql_ "SELECT datname FROM pg_database")
}

drop_lane_databases() {
  local base="$1" name dropped=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    dropped=1
    dropdb --if-exists "$name" && info "dropped $name"
  done < <(lane_databases "$base")
  (( dropped )) || info "no database named $base"
}

# --------------------------------------------------------------- processes
#
# A lane outlives its teardown in one place git and postgres cannot see: the
# processes pointed at it. After the #966 lane reported done, an `opencode run`
# from one of its probes was still alive 34 minutes later, burning tokens, in
# no report and raising no error (#970).
#
# `remove` therefore REPORTS them and does not kill by default. The match is a
# substring of the command line — it has to be, because opencode takes the lane
# both positionally (`opencode <dir>`) and as `--dir <dir>` — and a substring
# match cannot tell a runaway session from the operator's own editor, shell or
# `rg` with the same path on its argv. Killing a live session by accident is a
# worse failure than the leak it fixes, so the loud list is the default and
# `--kill-procs` is the opt-in.

# Every ancestor of this script, so the report never names the shell it is
# running inside — `lane.sh remove` is itself a process with the lane path on
# its command line.
ancestor_pids() {
  local pid="${1:-$$}" out=""
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    out+="$pid "
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  done
  printf '%s' "$out"
}

# Processes whose command line points at <dir>. Prints "<pid>\t<argv>".
lane_processes() {
  local dir="$1" skip pid args
  [[ -n "$dir" ]] || return 0
  skip=" $(ancestor_pids) "
  while IFS=' ' read -r pid args; do
    [[ "$skip" == *" $pid "* ]] && continue
    [[ "$args" == *"$dir"* ]] || continue
    printf '%s\t%s\n' "$pid" "$args"
  done < <(ps -eww -o pid=,args= 2>/dev/null)
}

# The worktree this lane owns, found by its branch rather than remembered in a
# metadata file that can go stale against `git worktree list`.
worktree_for_branch() {
  local want="refs/heads/$1" path=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ "$want") printf '%s\n' "$path"; return 0 ;;
    esac
  done < <(git worktree list --porcelain)
  return 1
}

# A branch name is not enough to find the lane: --agent and --slug are options.
# Match on the worktree directory, which always starts <issue>-.
worktree_for_issue() {
  local issue="$1" primary="$2" path
  while IFS= read -r path; do
    [[ "$path" == "$primary" ]] && continue
    case "$(basename "$path")" in
      "$issue"-*) printf '%s\n' "$path"; return 0 ;;
    esac
  done < <(git -C "$primary" worktree list --porcelain \
    | awk '/^worktree /{ sub(/^worktree /, ""); print }')
  return 1
}

# Slug and phase, from the issue unless forced. One fewer thing to typo, and the
# branch name then matches the issue it claims. Prints "<slug>\t<phase>".
# `create` and `start` share it so a predicted lane path and a created one can
# never disagree.
lane_meta() {
  local issue="$1" slug="$2" phase="$3"

  if [[ -z "$slug" || -z "$phase" ]]; then
    command -v gh >/dev/null || die "gh is not installed — pass --slug and --phase"
    [[ -d "$GH_CFG" ]] || die "missing $GH_CFG — see skill findash-github"
    local meta
    meta="$(gh_ api "repos/:owner/:repo/issues/$issue" \
      --jq '{title, labels: [.labels[].name]}' 2>/dev/null)" \
      || die "issue #$issue does not exist (or gh cannot read it)"
    if [[ -z "$slug" ]]; then
      # Drop the conventional-commit prefix and the trailing (#N) back-reference.
      slug="$(slugify "$(jq -r '.title' <<< "$meta" \
        | sed -e 's/^[a-z]*([^)]*)!*: *//' -e 's/^[a-z]*!*: *//' -e 's/ *(#[0-9]*)$//')")"
      [[ -n "$slug" ]] || die "could not derive a slug from the issue title — pass --slug"
    fi
    if [[ -z "$phase" ]]; then
      phase="$(jq -r '[.labels[] | select(startswith("phase-"))][0] // ""' <<< "$meta")"
      phase="${phase#phase-}"
      [[ -n "$phase" ]] || die "issue #$issue carries no phase-N label — pass --phase"
    fi
  fi

  printf '%s\t%s\n' "$(slugify "$slug")" "$phase"
}

# --------------------------------------------------------------------- create

cmd_create() {
  local issue="" slug="" phase="" agent="claude" base="origin/main"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --issue) issue="${2:?--issue needs a number}"; shift 2 ;;
      --slug)  slug="${2:?--slug needs a value}"; shift 2 ;;
      --phase) phase="${2:?--phase needs a number}"; shift 2 ;;
      --agent) agent="${2:?--agent needs a name}"; shift 2 ;;
      --base)  base="${2:?--base needs a ref}"; shift 2 ;;
      *)       die "unknown flag for create: $1" ;;
    esac
  done

  [[ "$issue" =~ ^[0-9]+$ ]] || die "create needs --issue <number>"

  step "Pre-flight"
  command -v bun >/dev/null || die "bun is not installed"
  command -v createdb >/dev/null || die "createdb is not on PATH (postgres client tools)"

  local primary
  primary="$(primary_root)"
  info "primary checkout: $primary"

  [[ -f "$primary/.env.local" ]] \
    || die "$primary/.env.local is missing — a lane without it fails at runtime.
     Copy .env.example and fill it in before creating lanes."

  local meta
  meta="$(lane_meta "$issue" "$slug" "$phase")" || exit 1
  IFS=$'\t' read -r slug phase <<< "$meta"

  local branch dir db
  branch="${agent}/phase-${phase}/${issue}-${slug}"
  dir="${primary}-worktrees/${issue}-${slug}"
  db="${DB_PREFIX}_${issue}"

  info "branch:   $branch"
  info "worktree: $dir"
  info "test DB:  $db"

  # Refuse a second half-lane over an existing one. Every one of these is a
  # reason the lane already exists somewhere; none of them is recoverable by
  # continuing.
  [[ -e "$dir" ]] && die "$dir already exists — 'scripts/lane.sh remove --issue $issue' first"
  git -C "$primary" show-ref --quiet --verify "refs/heads/$branch" \
    && die "branch $branch already exists — 'scripts/lane.sh remove --issue $issue' first"
  worktree_for_branch "$branch" >/dev/null \
    && die "a worktree is already checked out on $branch"
  [[ -n "$(lane_databases "$db")" ]] \
    && die "database $db already exists — 'scripts/lane.sh remove --issue $issue' first"

  local created_worktree=0 created_db=0 create_done=0
  rollback() {
    (( create_done )) && return 0
    (( created_worktree || created_db )) || return 0
    warn "create failed — rolling back the partial lane"
    if (( created_worktree )); then
      git -C "$primary" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
      git -C "$primary" branch -D "$branch" >/dev/null 2>&1 || true
      git -C "$primary" worktree prune 2>/dev/null || true
    fi
    (( created_db )) && drop_lane_databases "$db"
    return 0
  }
  trap rollback EXIT

  step "Worktree"
  git -C "$primary" fetch --quiet origin main || warn "could not fetch origin/main"
  git -C "$primary" rev-parse --verify -q "$base" >/dev/null \
    || die "cannot resolve base ref '$base'"
  git -C "$primary" worktree add -q -b "$branch" "$dir" "$base"
  created_worktree=1
  info "$branch at $(git -C "$dir" rev-parse --short HEAD)"

  cp "$primary/.env.local" "$dir/.env.local"
  info "copied .env.local (gitignored — never reaches the lane through git)"

  step "Dependencies"
  info "node_modules is not shared between worktrees"
  (cd "$dir" && bun install)

  step "Test database"
  createdb "$db"
  created_db=1
  # NOT optional: a fresh database inherits the server timezone and exactly two
  # consolidate specs then fail on a date boundary. dropdb+createdb wipes it.
  psql -d "$db" -q -c "ALTER DATABASE \"$db\" SET timezone TO 'UTC';"
  info "created $db (timezone UTC)"
  (cd "$dir" && FINDASH_TEST_DB="$db" bun run db:migrate:test)
  (cd "$dir" && FINDASH_TEST_DB="$db" bun run db:seed:test)

  create_done=1
  trap - EXIT

  step "Lane ready"
  printf '\n  Worktree: %s\n  Branch:   %s\n  Test DB:  %s\n\n' "$dir" "$branch" "$db"
  printf '  Start the orchestrator with its cwd INSIDE the lane — everything it\n'
  printf '  spawns inherits that cwd, and that is the whole isolation:\n\n'
  printf '    cd %s\n    export FINDASH_TEST_DB=%s\n\n' "$dir" "$db"
  printf '  Tear it down the moment the PR merges:\n\n'
  printf '    scripts/lane.sh remove --issue %s\n\n' "$issue"
}

# ----------------------------------------------------------------- start: talk
#
# `start` with no --issue (#956). A conversation, not a lane: explore the idea,
# agree the scope, and let the orchestrator write the issue the work then needs
# — its allow-list carries `gh issue create` as of #956, so the flow no longer
# dead-ends at the one step `AGENTS.md` § Issue-first makes mandatory.
#
# It owns NOTHING: no worktree, no branch, no database, so there is nothing to
# tear down and no `remove` call anywhere in this function. That is deliberate
# rather than incidental — see the dispatch comment in cmd_start.
#
# A talk session does not carry into a lane afterwards and is not meant to:
# `opencode debug scrap` keys projects by worktree path, so sessions do not port
# across worktrees. The issue IS the handoff — written, reviewable, and source
# of truth #1. Chat history is the draft.
start_talk() {
  local model="$1" auto="$2" dry_run="$3"

  step "Pre-flight"
  command -v opencode >/dev/null || die "opencode is not on PATH — start launches it"

  local primary
  primary="$(primary_root)"
  info "primary checkout: $primary"

  step "Talk session"
  info "no --issue: no worktree, no branch, no database — and nothing to tear down"
  info "the orchestrator opens the issue itself once the scope is agreed"
  info "it cannot implement here: 'scripts/lane.sh check' refuses the primary checkout"

  # No FINDASH_TEST_DB: a talk session owns no database, and exporting the
  # shared one would invite a bare `bun run test` onto another lane's fixtures.
  local -a launch=(opencode "$primary" --agent findash-orchestrator)
  (( auto )) && launch+=(--auto)
  [[ -n "$model" ]] && launch+=(-m "$model")

  if (( dry_run )); then
    info "would run, with cwd $primary:"
    printf '\n    %s\n\n' "$(printf '%q ' "${launch[@]}" | sed 's/ $//')"
    step "Outcome"
    info "decision: no lane → nothing to create, nothing to tear down"
    return 0
  fi

  cd "$primary"
  local rc=0
  "${launch[@]}" || rc=$?
  (( rc == 0 )) || warn "opencode exited $rc"

  step "Nothing to tear down"
  printf '\n  A talk session owns no lane. Once the scope is an issue, open its lane:\n\n'
  printf '    scripts/lane.sh start --issue <N>\n\n'
  return 0
}

# ------------------------------------------------------------------ watchdog
#
# On #921 the worktree and branch were deleted while the session was live.
# opencode went on waiting for a directory that no longer existed, `start` went
# on waiting for opencode, and the post-exit teardown — the code that drops the
# lane's database — never ran. `findash_test_921` was orphaned and nothing said
# a word (#970).
#
# The detection has to run BESIDE the session rather than inside it: `start`
# launches the INTERACTIVE tui, and a tui cannot be backgrounded — a script's
# background job gets /dev/null on stdin, and a session with no keyboard is no
# session. So this loop runs in the background and the tui keeps the terminal.
#
# It kills only its sibling: the opencode this shell started. Not the process
# group, because this shell still has an outcome to report.
watch_lane_dir() {
  local dir="$1" parent="$2" me pid ppid args
  me="$BASHPID"

  while [[ -d "$dir" ]]; do
    kill -0 "$parent" 2>/dev/null || return 0
    sleep 5
  done

  while IFS=' ' read -r pid ppid args; do
    [[ "$ppid" == "$parent" && "$pid" != "$me" && "$args" == *opencode* ]] || continue
    kill "$pid" 2>/dev/null || true
  done < <(ps -eww -o pid=,ppid=,args= 2>/dev/null)
  return 0
}

# ---------------------------------------------------------------------- start

cmd_start() {
  local issue="" slug="" phase="" agent="claude" base="origin/main"
  local model="" auto=1 dry_run=0
  # --agent and --base carry defaults, so "was it passed?" cannot be read back
  # off the variable. Record the lane-shaping flags as they arrive instead.
  local -a lane_flags=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --issue)    issue="${2:?--issue needs a number}"; shift 2 ;;
      --slug)     slug="${2:?--slug needs a value}"; lane_flags+=(--slug); shift 2 ;;
      --phase)    phase="${2:?--phase needs a number}"; lane_flags+=(--phase); shift 2 ;;
      --agent)    agent="${2:?--agent needs a name}"; lane_flags+=(--agent); shift 2 ;;
      --base)     base="${2:?--base needs a ref}"; lane_flags+=(--base); shift 2 ;;
      -m|--model) model="${2:?--model needs provider/model}"; shift 2 ;;
      --auto)     auto=1; shift ;;
      --no-auto)  auto=0; shift ;;
      --dry-run)  dry_run=1; shift ;;
      *)          die "unknown flag for start: $1" ;;
    esac
  done

  # ---------------------------------------------------------------- the fork
  #
  # Two modes, and the split is a hard fork rather than a branch inside one
  # body: with no --issue, start_talk runs and cmd_start RETURNS here. Every
  # line below this block — create-or-reuse, and the teardown that calls
  # `remove` — is unreachable without an issue number.
  #
  # That matters asymmetrically. Falling through to create-or-reuse would be
  # merely wrong; falling through to the teardown would call `remove --issue ""`
  # and start deleting worktrees and dropping databases on an empty match. So
  # the talk path is not allowed to be *in* that body at all. Anything that
  # needs both modes goes in a helper both call, never in the fallthrough.
  if [[ -z "$issue" ]]; then
    (( ${#lane_flags[@]} == 0 )) \
      || die "${lane_flags[*]} shape a lane, and 'start' with no --issue creates none.
     Pass --issue <number> to open a lane, or drop those flags to talk."
    start_talk "$model" "$auto" "$dry_run"
    return
  fi

  [[ "$issue" =~ ^[0-9]+$ ]] || die "start needs --issue <number>"

  step "Pre-flight"
  command -v opencode >/dev/null || die "opencode is not on PATH — start launches it"

  local primary invoked_from db
  primary="$(primary_root)"
  invoked_from="$(pwd -P)"
  db="${DB_PREFIX}_${issue}"
  info "primary checkout: $primary"

  # ------------------------------------------------------------- 1. the lane
  step "Lane"
  local dir="" branch=""

  if dir="$(worktree_for_issue "$issue" "$primary")"; then
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    info "reusing the existing lane — resuming #$issue is the same command"
    info "worktree: $dir"
    info "branch:   $branch"

    # A half-made lane is worse than none. Fail here rather than let the
    # orchestrator discover it three delegations in.
    [[ -f "$dir/.env.local" ]] \
      || die "$dir has no .env.local — 'scripts/lane.sh remove --issue $issue' and start again"
    [[ -d "$dir/node_modules" ]] \
      || die "$dir has no node_modules — 'scripts/lane.sh remove --issue $issue' and start again"
    [[ -n "$(lane_databases "$db")" ]] \
      || die "database $db is gone — 'scripts/lane.sh remove --issue $issue' and start again"
  else
    # Predict the path the same way `create` derives it — same helper, so a
    # dry run cannot print a launch line that create would not produce.
    local meta
    meta="$(lane_meta "$issue" "$slug" "$phase")" || exit 1
    IFS=$'\t' read -r slug phase <<< "$meta"
    branch="${agent}/phase-${phase}/${issue}-${slug}"
    dir="${primary}-worktrees/${issue}-${slug}"

    if (( dry_run )); then
      info "no lane for #$issue yet — would create:"
      info "  worktree: $dir"
      info "  branch:   $branch"
      info "  test DB:  $db"
    else
      cmd_create --issue "$issue" --slug "$slug" --phase "$phase" \
        --agent "$agent" --base "$base"
      # git is authoritative over the prediction above: if `create` ever changes
      # how it names a lane, `start` follows it instead of drifting.
      dir="$(worktree_for_issue "$issue" "$primary")" \
        || die "created the lane for #$issue but cannot find its worktree"
      branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    fi
  fi

  # ---------------------------------------------------------- 2. the process
  step "Orchestrator"

  # Stand in the PRIMARY checkout for the whole run. opencode takes the lane as
  # its positional argument, so it does not need our cwd — and phase 3 calls
  # `remove`, which refuses to run from inside the lane it is deleting (#949).
  # Launching from the lane would make `start` trip its own guard.
  cd "$primary"

  # No --prompt: the opening exchange with the orchestrator is where a badly
  # scoped issue gets caught, and it is worth more than the minute it costs.
  local -a launch=(opencode "$dir" --agent findash-orchestrator)
  (( auto )) && launch+=(--auto)
  [[ -n "$model" ]] && launch+=(-m "$model")

  local rc=0
  if (( dry_run )); then
    info "would run, with cwd $primary:"
    printf '\n    FINDASH_TEST_DB=%s %s\n\n' "$db" "$(printf '%q ' "${launch[@]}" | sed 's/ $//')"
  else
    [[ -d "$dir" ]] \
      || die "$dir does not exist — there is no lane to start a session in.
     Clear what is left with 'scripts/lane.sh remove --issue $issue', then start again."

    info "FINDASH_TEST_DB=$db"
    info "opencode starts in $dir; this shell stays in $primary"
    local watchdog=""
    watch_lane_dir "$dir" "$$" & watchdog=$!
    FINDASH_TEST_DB="$db" "${launch[@]}" || rc=$?
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    (( rc == 0 )) || warn "opencode exited $rc"
  fi

  # The lane can vanish under a live session (#921). Everything below reads git
  # and GitHub for a branch whose checkout is gone and then decides on a
  # teardown that has nothing left to tear down — so stop here instead, loudly,
  # and name the database that is still on disk.
  if (( ! dry_run )) && [[ ! -d "$dir" ]]; then
    step "Lane vanished"
    warn "$dir no longer exists — the session was waiting on a directory that is gone"
    git -C "$primary" worktree prune 2>/dev/null || true
    local leftover
    leftover="$(lane_databases "$db")"
    [[ -n "$leftover" ]] && info "still on disk: $(tr '\n' ' ' <<< "$leftover")"
    die "the lane for #$issue is gone and nothing was torn down.
     Clear what is left with 'scripts/lane.sh remove --issue $issue'."
  fi

  # --------------------------------------------------------- 3. the teardown
  #
  # Reporting is NOT here: an interactive session hands control back whenever
  # the human quits, which can be hours after the run ended. `scripts/ship.sh`
  # comments and notifies at the moment it learns CI is red or the merge was
  # refused. All that is left here is the lane itself.
  step "Outcome"

  local pr_state="" pr_url="" pr_json
  if pr_json="$(gh_ api "repos/:owner/:repo/pulls?head=:owner:$branch&state=all" \
    --jq '.[0] // {} | {state: (if .merged_at != null then "MERGED" else (.state // "" | ascii_upcase) end), url: (.html_url // "")}' 2>/dev/null)"; then
    pr_state="$(jq -r '.state // ""' <<< "$pr_json")"
    pr_url="$(jq -r '.url // ""' <<< "$pr_json")"
  fi
  info "branch: $branch"
  if [[ -n "$pr_url" ]]; then
    info "PR:     $pr_url ($pr_state)"
  else
    info "PR:     none open for this branch"
  fi

  if [[ "$pr_state" == "MERGED" ]]; then
    if (( dry_run )); then
      info "decision: MERGED → would remove the lane"
      return 0
    fi
    cmd_remove --issue "$issue"
    if [[ "$invoked_from" == "$dir" || "$invoked_from" == "$dir"/* ]]; then
      warn "you started this from inside the lane — that directory is gone now.
    Run 'cd $primary' in this shell."
    fi
    return 0
  fi

  if (( dry_run )); then
    info "decision: ${pr_state:-no PR} → would keep the lane parked at $dir"
    return 0
  fi

  step "Lane parked"
  printf '\n  The PR for #%s is %s — the lane stays exactly as it is.\n\n' \
    "$issue" "${pr_state:-not open yet}"
  printf '  Worktree: %s\n  Branch:   %s\n  Test DB:  %s\n' "$dir" "$branch" "$db"
  [[ -n "$pr_url" ]] && printf '  PR:       %s\n' "$pr_url"
  printf '\n  Resume with the same command:\n\n    scripts/lane.sh start --issue %s\n\n' "$issue"
  return 0
}

# --------------------------------------------------------------------- remove

cmd_remove() {
  local issue="" force=0 kill_procs=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --issue)      issue="${2:?--issue needs a number}"; shift 2 ;;
      --force)      force=1; shift ;;
      --kill-procs) kill_procs=1; shift ;;
      *)            die "unknown flag for remove: $1" ;;
    esac
  done

  [[ "$issue" =~ ^[0-9]+$ ]] || die "remove needs --issue <number>"

  step "Pre-flight"
  local primary db
  primary="$(primary_root)"
  db="${DB_PREFIX}_${issue}"

  local dir="" branch=""
  dir="$(worktree_for_issue "$issue" "$primary" || true)"

  if [[ -n "$dir" ]]; then
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    info "worktree: $dir"
    info "branch:   $branch"
  else
    warn "no worktree for issue #$issue — removing whatever else is left"
  fi

  # Removing the directory you are standing in leaves the shell in a path that
  # no longer exists and the rest of the teardown running against nothing.
  local here
  here="$(pwd -P)"
  if [[ -n "$dir" && ( "$here" == "$dir" || "$here" == "$dir"/* ) ]]; then
    die "refusing to remove the lane you are inside — run this from $primary"
  fi

  # git branch -D destroys commits. A squash-merge rewrites them, so
  # `origin/main..branch` is still non-empty after a perfectly good merge:
  # ask GitHub whether the PR landed rather than guessing from the graph.
  local migration_touched=0
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    local ahead
    ahead="$(git -C "$primary" rev-list --count "origin/main..$branch" 2>/dev/null || echo 0)"
    if (( ahead > 0 )) && (( ! force )); then
      local pr_state=""
      if command -v gh >/dev/null && [[ -d "$GH_CFG" ]]; then
        pr_state="$(gh_ api "repos/:owner/:repo/pulls?head=:owner:$branch&state=all" \
          --jq '.[0] // {} | if .merged_at != null then "MERGED" else (.state // "" | ascii_upcase) end' 2>/dev/null || true)"
      fi
      [[ "$pr_state" == "MERGED" ]] \
        || die "$branch has $ahead commit(s) not on origin/main and no merged PR (state: ${pr_state:-none}).
     Ship it first, or pass --force to delete the work."
      info "PR is MERGED — the $ahead commit(s) are squashed onto main"
    fi
    git -C "$primary" diff --name-only "origin/main...$branch" 2>/dev/null \
      | grep -q '^drizzle/' && migration_touched=1
  fi

  # Before the worktree goes: a process pointed at a directory that still
  # exists can be looked up and reasoned about; one pointed at a deleted path
  # is just a pid with a story.
  local left_running=0
  local -a procs_report=()
  if [[ -n "$dir" ]]; then
    local -a pids=()
    local line pid args
    while IFS=$'\t' read -r pid args; do
      [[ -n "$pid" ]] || continue
      pids+=("$pid")
      if (( kill_procs )); then
        kill "$pid" 2>/dev/null || true
        line="SIGTERM $pid  ${args:0:160}"
      else
        line="still running: $pid  ${args:0:160}"
      fi
      procs_report+=("$line")
    done < <(lane_processes "$dir")

    step "Processes"
    if (( ${#pids[@]} == 0 )); then
      info "nothing is still pointed at the lane"
    else
      for line in "${procs_report[@]}"; do
        if (( kill_procs )); then info "$line"; else warn "$line"; fi
      done
      if (( kill_procs )); then
        sleep 2
        for pid in "${pids[@]}"; do
          if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
            warn "$pid ignored SIGTERM — killed"
          fi
        done
      else
        left_running=${#pids[@]}
        warn "the worktree is about to go; these outlive it and keep spending.
    Check what they are, then 'kill ${pids[*]}' — or re-run with --kill-procs.
    A path on a command line is not proof: your own editor or shell matches too."
      fi
    fi
  fi

  step "Teardown"
  if [[ -n "$dir" ]]; then
    git -C "$primary" worktree remove --force "$dir" 2>/dev/null \
      || warn "git worktree remove failed — removing the directory directly"
    [[ -e "$dir" ]] && rm -rf "$dir"
    info "removed worktree $dir"
  fi
  git -C "$primary" worktree prune

  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    if git -C "$primary" show-ref --quiet --verify "refs/heads/$branch"; then
      git -C "$primary" branch -D "$branch" >/dev/null
      info "deleted branch $branch"
    fi
  fi

  drop_lane_databases "$db"

  # The lane's own database had the new migration; you just dropped it. Skip
  # this and the next full-suite run on the SHARED database fails on tests that
  # are green in CI — a regression on main that is not one.
  if (( migration_touched )); then
    step "Shared test database"
    info "the lane shipped a migration — re-migrating $DB_PREFIX"
    (cd "$primary" && bun run db:migrate:test) \
      || warn "re-migration failed — run 'bun run db:migrate:test' in $primary before the next suite"
  fi

  step "Lane gone"
  printf '\n  Nothing left for issue #%s: no worktree, branch, database or directory.\n' "$issue"
  # "Nothing left" has to be true, or the next reader stops looking.
  if (( left_running )); then
    printf '\n'
    warn "except $left_running process(es) listed above, still running against a
    directory that no longer exists. They are yours to kill."
  fi
  printf '\n'
}

# ---------------------------------------------------------------------- check

cmd_check() {
  [[ $# -eq 0 ]] || die "check takes no flags"

  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not inside a git repository"

  local git_dir common root branch
  git_dir="$(git rev-parse --path-format=absolute --git-dir)"
  common="$(git rev-parse --path-format=absolute --git-common-dir)"
  root="$(git rev-parse --show-toplevel)"
  branch="$(git rev-parse --abbrev-ref HEAD)"

  # In a linked worktree --git-dir is <common>/worktrees/<name>. Equal means
  # this is the primary checkout, whatever branch it happens to be on.
  [[ "$git_dir" != "$common" ]] \
    || die "this is the PRIMARY checkout ($root) — it stays on main and never hosts a lane.
     Create one and relaunch with its cwd inside:
       scripts/lane.sh create --issue <N>"

  [[ "$branch" != "main" ]] \
    || die "HEAD is main in $root — a lane works on its own branch."

  [[ -f "$root/.env.local" ]] \
    || die ".env.local is missing in $root — it is gitignored, so the worktree
     never got one and the lane will fail at runtime. Re-create the lane."

  [[ -d "$root/node_modules" ]] \
    || die "node_modules is missing in $root — it is not shared between
     worktrees. Run 'bun install' here, or re-create the lane."

  local issue db
  issue="$(basename "$root")"; issue="${issue%%-*}"
  db="${FINDASH_TEST_DB:-${DB_PREFIX}_${issue}}"

  printf '%s ✓  lane%s  %s on %s\n' "$c_grn" "$c_off" "$root" "$branch"
  if [[ -z "${FINDASH_TEST_DB:-}" ]]; then
    warn "FINDASH_TEST_DB is unset — a bare 'bun run test' uses the shared
    $DB_PREFIX and corrupts another lane's fixtures. Export FINDASH_TEST_DB=$db"
  else
    info "FINDASH_TEST_DB=$FINDASH_TEST_DB"
  fi
}

# ------------------------------------------------------------------ dispatch

[[ $# -gt 0 ]] || { usage; exit 1; }

case "$1" in
  create)    shift; cmd_create "$@" ;;
  start)     shift; cmd_start "$@" ;;
  remove)    shift; cmd_remove "$@" ;;
  check)     shift; cmd_check "$@" ;;
  -h|--help) usage; exit 0 ;;
  *)         die "unknown subcommand: $1 (create | start | remove | check)" ;;
esac
