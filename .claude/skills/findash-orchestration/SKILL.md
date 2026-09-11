---
name: findash-orchestration
description: How work reaches main in findash — the four roles and their trigger criteria, launching opencode lanes over herdr with a worktree, a per-lane database and a pinned model, deny-first permissions per role, why the reviewer must differ from the implementer, prompt design (objective not route), running parallel lanes, and the herdr event-subscription gotchas. Load ONLY when orchestrating delegated lanes. A worker agent executing a task does not need this.
---

# Findash agent orchestration

**The orchestrator does not write code.** It delegates, then reviews what came
back. Work reaches `main` through opencode lanes launched over herdr, one role
per lane. Claude Code is the orchestrator and nothing else — it is the most
expensive model per token in the system, so it spends its budget on judgement,
not on volume.

There used to be a second route (Claude Code sub-agents in `.claude/agents/`).
It is gone as of #922: the two sets of definitions had drifted to 590 lines
versus 274 with no body matching its twin, only the opencode half was in git, and
a sub-agent runs on the same subscription as the orchestrator — which is the
budget this architecture exists to protect.

## The four roles

| Agent | Role | When to invoke |
| --- | --- | --- |
| `findash-explorer` | Read-only digest | BEFORE implementer when the task touches 4+ files, needs a module map, needs prior art from engram, or the issue scope is unclear. Skip for obvious tasks. |
| `findash-implementer` | Code + tests + lint/typecheck + commit | For EVERY code change. Turns a claimed issue into a branch ready to ship. Does NOT push, does NOT open PRs. |
| `findash-reviewer` | Read-only review (CRITICAL / WARNING / SUGGESTION) | BETWEEN implementer and ship.sh for non-trivial changes: db schema, queries, server actions, money logic, tenant-scoped data. Skip for docs-only, test-only, or mechanical refactors. |
| `scripts/ship.sh` | Push + PR + CI watch | AFTER implementer (and reviewer if applicable). A deterministic bash script, not a model — a model cannot wait for CI, and waiting is the whole job. |

```
gh issue (claim) → findash-explorer      (if 4+ files or scope unclear)
                 → findash-implementer   (ALWAYS — do not write code directly)
                 → findash-reviewer      (non-trivial: db, money, tenant, server actions)
                 → scripts/ship.sh       (push + PR + CI; merge is a parent/human action)
```

Why: **the orchestrator does not know the 50+ gotchas** documented in engram for
this repo. The lanes do — they `mem_search` first thing and load the matching
skill. Bypassing them re-introduces bugs already paid for.

## Model routing (task 8 of #922)

Definitions pin `model:` in their own frontmatter. Do not leave it unset and do
not rely on the operator's profile — the profile is what silently reintroduced
the blindness this table exists to prevent.

| Role | Model | Lineage | ~$/task |
| --- | --- | --- | ---: |
| Orchestrator | Claude Code, Sonnet | Anthropic | subscription |
| `findash-explorer` | `llmgateway/gpt-5.6-luna` | OpenAI | ~$0.10 |
| `findash-implementer` | `llmgateway/glm-5.3-flash` | Zhipu | ~$0.20 |
| `findash-reviewer` | `llmgateway/muse-spark-1.3` | Meta | ~$0.55 |
| Reviewer ceiling | `llmgateway/claude-opus-5` | Anthropic | ~$6 |
| Overflow | `deepseek/deepseek-v4-flash` | DeepSeek | ~$0.20 |

**The rule is not "the reviewer uses muse-spark". It is "the reviewer must differ
from the implementer's lineage."** A reviewer sharing the implementer's model
shares its blind spots and confirms what it already judged correct once. Assert
this at launch: if you override either model with `-m`, check the pair.

Raise the reviewer to `claude-opus-5` for diffs touching money, schema, or a
tenant boundary. It is ~11× the cost of the default reviewer and still cheaper
than the bug.

`gpt-6-astra` is deliberately not used: on DevPass it is priced at exactly 2×
Opus 5 on every axis, and premium fair-use is the binding constraint — Lite
grants premium only ~12% of monthly credits on a fixed 7-day window.

## Launch role-specialized

Lanes launch already wearing a role. The prompt then carries only the objective,
per § Prompt design. Do not smuggle the role into the prompt — that is the "map"
that section measures as producing a worse result.

```bash
herdr agent start <lane> --kind opencode --pane <pane_id> -- --agent findash-implementer
```

Definitions live in `.opencode/agents/findash-{explorer,implementer,reviewer}.md`
and are committed. `.opencode/` is deliberately not gitignored. `.claude/` is
ignored **except `.claude/skills/`**, which every lane needs — opencode reads
`.claude/skills/*/SKILL.md` natively, so one directory serves both runtimes.

## `--auto` plus deny-first

`opencode --auto` auto-approves anything **not explicitly denied**. Alone that
is wrong: an unbounded lane could merge without asking. Each `findash-*`
definition therefore carries a deny-first permission block so the role is
safe unattended. `--auto` is then per-role: a reviewer in auto still cannot
edit, because its own definition forbids it.

Do not run a lane with `--auto` unless its definition already denies the
surfaces that role must not touch. Herdr forwards native args after `--`:

```bash
herdr agent start <lane> --kind opencode --pane <pane_id> -- --auto --agent findash-reviewer
```

What each role allows and denies (last matching bash rule wins — verified on
opencode 1.18.30 by launching a lane and watching a denied command come back
with *"The user has specified a rule which prevents you from using this specific
tool call"*, under `--auto`):

| Role | `bash` default | Shape |
| --- | --- | --- |
| explorer, reviewer | **`"*": deny`** | Allow-list of read-only commands: `rg`/`fd`/`bat`/`eza`/`jq`, `codegraph`, read-only `git`, read-only `gh`. `edit: deny` also blocks `write` and `apply_patch` — there is no separate `write` permission key. |
| implementer | `"*": allow` | Denies push/PR/merge (`scripts/ship.sh`'s job), history surgery (`rebase`, `reset --hard`, checkout to `main`), anything with `--no-verify`, `gh auth switch`/`setup-git`, `dropdb`, `psql -d findash`, `ssh`, `pm2`, `rm -rf`. |

There is no shipper lane. `scripts/ship.sh` does that job — see § Shipping.

The two read-only roles get a deny-default because their command set is small
and enumerable. The implementer does not: an allow-list there breaks the lane on
the first legitimate command nobody anticipated, and a blocked lane under
`--auto` is a pane that looks alive and is not. Bound it by denying what is out
of remit instead.

`read` is a separate key from `edit`, so `edit: deny` leaves reading intact.
Definitions do not set `external_directory` and do not hardcode operator
paths. Once the files are in the worktree, a lane should never leave it.

## Review gate is not automatic

A lane told to go "end to end" will skip the reviewer unless the
orchestrator inserts it. For non-trivial changes (db schema/queries, server
actions, money logic, tenant-scoped data) the orchestrator MUST insert a
reviewer stage before merge, and the implementing lane MUST stop at PR-open
rather than auto-merge. Mechanical refactors, docs-only, and test-only changes
keep skipping the reviewer.

## Epic-phase PRs do not close the epic

A PR delivering one phase of a multi-phase epic uses `Part of #N`, never
`Closes #N` — otherwise the epic dies with remaining phases unwritten. That
PR also fails auto-merge condition (b) ("PR closes a single issue"), so it
stops at PR-open and waits for a human.

## One lane, end to end

```bash
# 1. Worktree, its own workspace, its first tab and a root pane — one call.
#    Read workspace_id, tab_id and root_pane.pane_id out of the JSON it
#    returns. Never assume a wN:pM: ids are not stable across a close.
herdr worktree create --cwd "$PWD" \
  --branch claude/phase-4/<issue>-<slug> --base main \
  --path ~/projects/personal-financial-dashboard-worktrees/<lane> \
  --label <lane> --no-focus
# .env.local is gitignored — without this copy the worktree fails at runtime
cp .env.local ~/projects/personal-financial-dashboard-worktrees/<lane>/.env.local

# 2. Its own database — the timezone step is NOT optional (see skill findash-testing)
createdb findash_test_<lane>
psql -d postgres -c "ALTER DATABASE findash_test_<lane> SET timezone TO 'UTC';"
FINDASH_TEST_DB=findash_test_<lane> bun run db:migrate:test
FINDASH_TEST_DB=findash_test_<lane> bun run db:seed:test

# 3. node_modules is NOT shared between worktrees
cd ~/projects/personal-financial-dashboard-worktrees/<lane> && bun install

# 4. The root pane hosts the implementer. The later stage —
#    review — gets its OWN tab inside that same lane workspace:
#      herdr tab create --workspace <workspace_id> --cwd "$PWD" \
#        --label <lane>-review --no-focus
#    Never a pane split of the orchestrator's tab.
herdr agent start <lane> --kind opencode --pane <root_pane_id> --timeout 240000 \
  -- --auto --agent findash-implementer
herdr agent prompt <lane> "<objective>"

# 5. Teardown the moment it merges — workspace, worktree, branch, database
herdr workspace close <workspace_id>   # closes every tab of the lane at once
git worktree remove ~/projects/personal-financial-dashboard-worktrees/<lane> --force
git branch -D claude/phase-4/<issue>-<slug>
dropdb findash_test_<lane>

# 6. If the lane shipped a migration, re-migrate the SHARED test database.
#    The lane's own database had it; you just dropped that one.
bun run db:migrate:test
```

`herdr worktree create` replaces the old `git worktree add` +
`herdr tab create` pair. It isolates per workspace rather than per tab, so a
lane's three stages live together and teardown is one call. `herdr worktree
list` reports each worktree with its `open_workspace_id`, which makes a lane's
workspace discoverable instead of remembered.

Closing a lane workspace does **not** touch the checkout — the worktree stays on
disk with its branch, and `open_workspace_id` goes to `null`. Reopen it with
`herdr worktree open --cwd <repo> --path <path> --label <lane> --no-focus`,
which returns **new** ids. Removing the checkout stays an explicit
`git worktree remove`, which is why step 5 keeps both.

> **Step 6 is the easy one to forget.** Skipping it leaves `findash_test`
> running the pre-merge schema, and the next full-suite run fails on tests that
> are green in CI. The symptom looks like a regression on `main` and is not one —
> check `drizzle.__drizzle_migrations` against `drizzle/meta/_journal.json`
> before debugging any code.


## Shipping

There is no shipper agent. `scripts/ship.sh` runs pre-flight, the gates, the
push, the PR and the CI watch — every step has exactly one correct answer, and
the step that dominates wall-clock is waiting for CI. A model cannot wait, which
is why the agent needed the "poll `gh pr checks` inline, never `ScheduleWakeup`"
workaround. `gh pr checks --watch` does it natively.

```bash
scripts/ship.sh                       # infer issue and link word from the commits
scripts/ship.sh --part-of             # epic-phase PR
scripts/ship.sh --no-test             # a parallel lane already ran the suite
scripts/ship.sh --dry-run             # gates only, push nothing
```

It refuses to ship from `main`, refuses a dirty tree, refuses a non-conventional
commit subject, and **never merges** — it prints whether `AGENTS.md` auto-merge
conditions hold and stops. Multiple issue numbers across the commits
automatically demote `Closes` to `Part of`.

Run it from the lane's worktree with that lane's `FINDASH_TEST_DB` exported, or
with `--no-test` if the implementer already ran the affected specs and no other
lane is idle.

## Prompt design: give the objective, not the route

Do **not** hand a delegated agent the repo's conventions. Measured on this repo:
an agent asked only _"what are this repo's conventions?"_, with no pointers,
independently read `AGENTS.md`, `CLAUDE.md` and `docs/`, **queried
engram on its own**, and surfaced tenant safety, the money convention and the
gotchas. The same agent
given a map produced a worse answer.

Pass only what cannot be derived from the repo:

1. The issue number.
2. `FINDASH_TEST_DB=findash_test_<lane>`, and that other agents are running so
   a bare `bun run test` would corrupt someone else's fixtures.
3. The stop condition — commit only, or all the way to merge.
4. Any decision the issue does not contain, **with its reasoning**.

Invite disagreement explicitly ("if this looks wrong, say so before
implementing"). That invitation has paid for itself: a delegated agent caught
that moving `DEFAULT_MODEL` to Sonnet 5 would silently break the SMS fallback's
2-second budget, and that issue #816's stated cache minimum was out of date.

## Operating parallel lanes

- **Cap at ~3 concurrent lanes on a dev Mac.** Lanes are RAM-bound, not
  isolation-bound. Isolation works — worktrees and per-lane databases produced
  zero conflicts across five lanes — but five simultaneous Vitest suites
  exhausted memory and the OS started killing processes.
- **A killed watcher is not a dead agent.** Delegated agents live in their own
  panes and keep working when the orchestrator's waiting process dies.
  `herdr agent prompt --wait` is fire-and-forget once the prompt lands; the wait
  is an observation channel, not a lifeline. Before re-prompting, check the
  lane's git/PR state (reviews, not just comments) — or you duplicate the work.
- **Register every lane with your watcher when it starts**, not when you
  remember it. One lane merged completely unobserved because its watcher was
  never rebuilt after being killed.
- **A prompt sent too early is silently dropped.** `herdr agent prompt` issued
  right after `herdr agent start` can vanish while the opencode TUI is still
  painting its splash. The call returns success, the agent stays `idle`, and the
  input line is empty — a lane that looks alive and never received its task.
  `agent start` returning `interactive_ready: true` is not enough. Confirm the
  turn actually began before registering a watcher: `terminal_title` flips to
  `OC | <objective>` once it does, and `agent read` shows the prompt in the
  transcript. Verified on herdr 0.9.0 / opencode 1.18.30.
- **Do not judge an agent from its scrollback.** A pane read mid-run surfaces
  hypotheses the agent later refutes itself. One review showed a `CRITICAL` in
  scrollback and ended `APPROVE` with zero findings. The agent runs on the
  terminal's alternate screen, so rows that scroll away never reach herdr's host
  scrollback and no `--lines` value brings them back. Ask for the final report —
  but **how depends on the role**:
  - `findash-implementer` can write it to a file (`/tmp/<lane>-digest.md`);
    read the file.
  - `findash-explorer` and `findash-reviewer` **cannot**. Both set `edit: deny`,
    which also blocks `write` and `apply_patch`. Asking one for a file leaves it
    at a permission dialog with `agent_status: blocked`, holding a finished
    report it cannot deliver. Do not relax the denial — a read-only role that
    can write files is not read-only. Both definitions therefore cap their own
    output (350 words for the explorer digest, 400 for the review) and deliver
    it in the pane. Short output never hits the scrollback problem. If one is
    already blocked, `herdr agent send-keys <name> esc`, then re-prompt.
- **A tab is not ready the moment `tab create` returns.** `herdr agent start`
  needs the target pane's shell at its interactive prompt. Called immediately
  after `herdr tab create` it fails with `agent_not_found` — even though the
  pane exists and `herdr pane list` reports it. The error names the agent, not
  the pane, so it reads like a bad `--pane`, and the identical command succeeds
  on retry seconds later. Wait for the shell before starting the agent.
- **Do not poll Herdr — it pushes.** Two mechanisms, both verified on herdr
  0.9.0.

  **Single-shot** — `herdr agent wait <target> --until <status> [--timeout MS]`.
  Blocks server-side (measured 8.06s wall on 0% CPU, so not a hidden poll).
  Statuses: `idle`, `working`, `blocked`, `done`, `unknown`. One notification,
  then it exits. Pair it with a background shell for one specific lane.

  **Streaming** — `events.subscribe` over the Unix socket at
  `~/.config/herdr/herdr.sock` (named sessions:
  `~/.config/herdr/sessions/<name>/herdr.sock`; `HERDR_SOCKET_PATH` overrides).
  Newline-delimited JSON. The first response acknowledges the subscription;
  every later line is a pushed event.

  ```bash
  REQ='{"id":"sub_1","method":"events.subscribe","params":{"subscriptions":[
    {"type":"pane.agent_status_changed","pane_id":"w1:pH","agent_status":"blocked"},
    {"type":"pane.agent_status_changed","pane_id":"w1:pH","agent_status":"done"}]}}'
  { printf '%s\n' "$REQ"; while :; do sleep 3600; done; } | nc -U ~/.config/herdr/herdr.sock
  ```

  Four gotchas:
  - **`pane_id` is required per subscription.** No wildcard. Omitting it fails
    with `invalid_request: missing field 'pane_id'`. One entry per pane.
  - **`agent_status` is a server-side filter — and `blocked`+`done` is not
    enough.** Subscribe to `idle` as well. A finished lane reports `idle` or
    `done` depending on whether the server already considers that completion
    seen, and both are delivered when you subscribe to them: verified on
    herdr 0.9.0 with two lanes finishing minutes apart, one arriving as
    `idle` and the other as `done`. A `blocked`+`done`-only filter goes
    permanently deaf to the `idle` half. Leave `working` out — that one is
    pure noise.
  - **A pushed event is NOT shaped like the request.** The subscription filter
    uses `type` + `pane_id`, but the event the server pushes uses different
    keys entirely:

    ```json
    {
      "event": "pane.agent_status_changed",
      "data": {
        "agent_status": "idle",
        "pane_id": "w1:p34",
        "agent": "opencode",
        "workspace_id": "w1"
      }
    }
    ```

    It is `event` / `data`, not `type` / `params`. A reader that looks for
    `type` (the name it just subscribed with) silently matches nothing and the
    watcher stays deaf while looking healthy. Do not trust the underscore
    names in `herdr api schema --json` either — that `EventKind` enum is the
    internal serialization (`pane_agent_status_changed`); the wire protocol
    uses dots, and subscribing with the underscore form is rejected with
    `invalid_request: unknown variant`.

  - **Hold the connection with a sleep loop, not `cat`.** Under a runner with
    no stdin, `cat` takes EOF immediately and the subscription dies one line
    after `subscription_started`.

  `herdr api schema --json` dumps the request/response/event schema.

- **When you poll GitHub, read the right collection.** A reviewer told to
  "post your review as a comment" posted a **pull request review**.
  `gh pr view <n> --json comments` returned `[]` while the verdict sat on the
  PR. The lane looked silent when it was finished.

  ```bash
  GH_CONFIG_DIR=~/.config/gh-findash gh api repos/<owner>/<repo>/pulls/<n>/reviews \
    --jq '.[]|{state,user:.user.login,body}'
  ```

  A review posted without an explicit approve or request-changes shows
  `state: "COMMENTED"`. Symptom: pane says "posted", herdr says `done`,
  comments array empty — check the reviews endpoint before re-prompting.

Other agents (Codex, etc.) driving this repo directly can ignore the lane
mechanics above — the rules in `AGENTS.md` (issue-first, branch naming, commits,
PRs, gh identity, testing) still apply to all agents equally.
