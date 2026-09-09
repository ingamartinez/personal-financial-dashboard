<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

Next.js 16 has breaking changes vs older versions — APIs, conventions, and file structure may differ from training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Findash — Agent Workflow

This file is the contract for any AI agent (Claude, Codex, etc.) or human contributor working on this repo. Multiple agents may run in parallel — the rules below prevent collisions.

## Source of truth hierarchy

1. **`PLAN.md`** — vision, architecture, ingestion flows, phased roadmap. Read FIRST when working on anything non-trivial.
2. **GitHub Issues** — granular tasks, bugs, features. Each issue has a `phase-N` label and one or more domain labels.
3. **GitHub Project board** ("Findash Roadmap") — kanban view: `Backlog` → `Next Up` → `In Progress` → `Done`.
4. **This file (`AGENTS.md`)** — workflow conventions only.

If `PLAN.md` and an issue conflict, ask the user — do not silently pick.

## Issue-first rule (mandatory)

> **gh CLI identity required** — all `gh` commands below must be prefixed with `GH_CONFIG_DIR=~/.config/gh-findash`. See [§ gh CLI identity](#gh-cli-identity) for the full rule.

**No code changes without an open issue.** Before any work:

1. Search existing issues: `gh issue list --search "<keywords>"`. If one exists, use it.
2. If none, create one: `gh issue create --title "..." --label "phase-N,<domain>" --body "..."`.
3. Comment on the issue claiming it: `gh issue comment <N> --body "Picking this up — agent: <name>"`. This is the lock signal for other agents.
4. Move the issue to `In Progress` on the Project board.

Why: prevents two agents from working on the same thing.

## Branch naming

```
<agent-name>/<phase>/<issue-number>-<short-slug>
```

Examples:

- `claude/phase-1/12-rule-engine`
- `codex/phase-2/27-sms-parser`

## Commit format (conventional commits, no AI attribution)

```
<type>(<scope>): <subject> (#<issue>)
```

Types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `perf`, `style`.

Examples:

- `feat(classification): add ILIKE rule engine (#12)`
- `fix(db): correct FK ordering on categories slug (#5)`
- `chore(ci): add typecheck workflow (#8)`

NEVER add `Co-Authored-By` or AI attribution lines.

## PR convention

- Title: same as the closing commit
- Body must include `Closes #<issue>` so the issue auto-closes on merge
- Self-review checklist (for solo or AI workflows): typecheck passes, lint passes, manual smoke test described, screenshots if UI changed
- Squash merge by default — keeps history linear
- **CI gate**: GitHub Actions (`.github/workflows/ci.yml`) runs lint + format check + typecheck + full test suite + `next build` on every PR and every push to `main`. A red CI blocks merge.
- **Auto-merge authorization**: AI agents may squash-merge their own PR into `main` without asking when ALL of: (a) CI is green on the latest commit, (b) PR closes a single issue, (c) no merge conflicts with `main`. Otherwise, ask the user before merging.

## Labels (canonical list)

| Label                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase-1`, `phase-2`, `phase-3`, `phase-4` | Roadmap phase from PLAN.md                                                                                                                                                                                                                                                                                                                                                         |
| `infra`                                    | Setup, tooling, deployment                                                                                                                                                                                                                                                                                                                                                         |
| `db`                                       | Schema, migrations, seed                                                                                                                                                                                                                                                                                                                                                           |
| `ingestion`                                | Data ingestion (Apple Pay, SMS, OCR, CSV, recurring)                                                                                                                                                                                                                                                                                                                               |
| `classification`                           | Rule engine + AI classifier                                                                                                                                                                                                                                                                                                                                                        |
| `ui`                                       | Pages, components, layout                                                                                                                                                                                                                                                                                                                                                          |
| `ai`                                       | Claude API integration (Haiku, Sonnet, Vision)                                                                                                                                                                                                                                                                                                                                     |
| `bug`                                      | Something broken                                                                                                                                                                                                                                                                                                                                                                   |
| `documentation`                            | Documentation only                                                                                                                                                                                                                                                                                                                                                                 |
| `good-first-task`                          | Small, well-scoped, easy entry point                                                                                                                                                                                                                                                                                                                                               |
| `blocked`                                  | Cannot proceed until an external condition is met (missing data, pending decision, dependency on another issue). Orthogonal to `phase-N` and to the Project board `Status` column — use it as a flag, not a status. When applying, leave a comment on the issue explaining WHAT it's blocked on. Filter it out with `-label:blocked` when looking for work you can actually start. |

## Tech baseline (do not deviate without an issue)

- **Runtime**: Bun 1.3+ (NOT Node directly for scripts — `bun run`)
- **Framework**: Next.js 16 (App Router, Turbopack default, no `--turbopack` flag)
- **Async APIs**: `cookies()`, `headers()`, `params`, `searchParams` MUST be `await`ed
- **DB**: PostgreSQL 17 native, peer auth via `/var/run/postgresql` socket. Connection via options object (NOT URL with `host=` param — postgres.js ignores it). See `src/lib/db/index.ts`.
- **ORM**: Drizzle 0.45+. Use `sql\`...\``template (not strings) in`.where()`, `.default()`, etc. Use `sql\`0\``instead of`0n` for BigInt defaults — drizzle-kit chokes on BigInt JSON.
- **FK to non-PK columns**: must use inline `.unique()` on the column (creates CONSTRAINT during table creation), NOT `uniqueIndex(...)` (creates AFTER, breaks FK ordering).
- **Money**: store as `bigint amount_cents`. Never floats.
- **Styling**: Tailwind 4 + shadcn/ui (when added). No CSS-in-JS, no inline styles for layout.
- **Tests**: Vitest. Co-locate `*.test.ts` / `*.test.tsx` next to source. Default env is `node`. For tests that mount React components, add `// @vitest-environment jsdom` as the **first line** of the file — do NOT change the global env (most specs hit Postgres and must stay on `node`). Available in jsdom specs: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` matchers (import via `import "@testing-library/jest-dom/vitest"`). Radix primitives need pointer-capture + scrollIntoView shims — see `src/components/transactions/quick-entry-dialog.test.tsx` for the working template. Factories inside `vi.mock(...)` are hoisted above top-level consts, so share mocks via `vi.hoisted(() => ({ ... }))`.
- **Logging**: ALL log output flows through `src/lib/logger.ts` (Pino). `console.*` is ESLint-blocked everywhere — `src/`, `scripts/`, `instrumentation.ts`, seeds. No exceptions. At the top of each module: `import { createLogger } from "@/lib/logger"; const log = createLogger({ module: "my-module" });`. Call sites use structured fields: `log.error({ err, userId, event: "thing_failed" }, "thing failed")` — NEVER concat user input into the message string. Pino's `err` serializer handles `Error` objects safely (escapes newlines, keeps stack) — this is what defeats CodeQL `js/log-injection` without helpers.
- **Background work**: Anything that runs outside the request lifecycle MUST go through `src/lib/queue` (BullMQ + Redis). Forbidden patterns: `setInterval`, `cron.schedule` (`node-cron` is removed from the project), `queueMicrotask` for async work, `after()` for anything beyond canary metrics. Cron schedules go in BullMQ as `{ repeat: { pattern: "0 3 * * *", tz: "America/Bogota" }, jobId: "<name>-recurring" }` — the `jobId` makes re-scheduling on restart idempotent. Dashboard at `/admin/queues` (requires admin role, `requireAdmin` gate). All workers use `createWorker(name, processor)` from `src/lib/queue/index.ts` — Pino logger + graceful shutdown wired in. Active queues: `fx-refresh`, `classify-tx`, `recurring-gap`, `health-snapshots`, `slo-alerts`, `gmail-pull`.
- **Recurring auto-link cold-start (accepted trade-off, #804)**: `src/lib/recurring/auto-link.ts`'s `resolveCandidate()` and `src/lib/recurring/gap-detector.ts`'s `resolveTxWinner()`/`resolveBijectiveGroups()` treat a recurring (or a group of indistinguishable recurrings) with **zero learned description-fingerprint patterns** as "nothing to contradict" and trust a same-account + exact-amount + in-window match on ANY tx description — including one that doesn't look related at all. This is deliberate, not a bug: it's bounded (blocked the moment the amount also collides with another active recurring, or after ~2 observations teach a real pattern) and reversible (one-tap "Deshacer match" in `/recurring`). Do NOT require a learned pattern before trusting this path — that would break every brand-new recurring's first month. See engram `architecture/804-*` for the full rationale before touching this logic.

## Multi-agent etiquette

- One issue → one agent at a time. Claim by commenting on the issue.
- If you find related work in progress, leave a comment on the OTHER agent's issue instead of opening a parallel branch.
- Never force-push to `main`. Never bypass hooks.
- If you discover a non-obvious gotcha, save it to engram (`mem_save`) AND add it to the relevant section of this file.
- After running scaffolders or codegen (`shadcn init/add`, `bunx create-*`, drizzle generators, etc.), run `git log -1` BEFORE committing manually. Some tools auto-create commits with non-conventional messages (e.g. `shadcn init -y` produced `feat: initial commit` here). If you find an unauthorized commit on your branch, `git reset --soft HEAD~1` and rebuild it with the proper `<type>(<scope>): <subject> (#<issue>)` format. Never push these auto-commits.

## gh CLI identity

ia-server runs multiple agents under the same Linux user. The default `~/.config/gh/` belongs to `amartinezcb` (the cc agent). Every `gh` invocation in this repo MUST be prefixed with `GH_CONFIG_DIR=~/.config/gh-findash` — without it you silently authenticate as the wrong account.

```bash
# CORRECT — always prefix every gh call
GH_CONFIG_DIR=~/.config/gh-findash gh issue list
GH_CONFIG_DIR=~/.config/gh-findash gh pr create ...

# WRONG — uses global config = amartinezcb's account
gh issue list
```

**HTTPS push** — the global git credential helper points at the wrong account, so inline the token:

```bash
TOK=$(GH_CONFIG_DIR=~/.config/gh-findash gh auth token --user ingamartinez)
git push "https://ingamartinez:${TOK}@github.com/ingamartinez/personal-financial-dashboard.git" HEAD
```

**NEVER run without the prefix:**

```bash
# These rewrite the global gitconfig and break the cc agent — always prefix them
GH_CONFIG_DIR=~/.config/gh-findash gh auth switch ...
GH_CONFIG_DIR=~/.config/gh-findash gh auth setup-git ...
```

**`workflow` scope** — the token may lack this scope (required to push changes to `.github/workflows/`). Fix once interactively:

```bash
GH_CONFIG_DIR=~/.config/gh-findash gh auth refresh -h github.com -s workflow
```

**Verify identity** at any time:

```bash
GH_CONFIG_DIR=~/.config/gh-findash gh auth status
# Should show: Logged in to github.com account ingamartinez
```

## Local commands

```bash
bun install
bun run dev              # http://localhost:3100
bun run db:generate      # generate migration from schema
bun run db:seed          # seed accounts, categories, rules
bun run lint
psql -d findash          # direct DB access (peer auth, no password)
```

`.env.local` is NOT committed — see `.env.example` for required vars.

## Production deploy

Full runbook: **`docs/deploy.md`**

Covers topology, host inventory, first-time bring-up, automated CD flow,
manual deploy via `workflow_dispatch`, rollback, day-2 ops, backup/restore,
secret rotation, R2 off-site backup setup, and the threat model.

## Test database (findash_test)

Integration tests DELETE rows during cleanup, so they MUST run against a
separate database. `vitest.setup.ts` forces `PGDATABASE` to a `findash_test*`
name before any test imports — this cannot be overridden by `.env.local` or
a shell env var outside that prefix. If the setup ever fails to apply, tests
abort loudly instead of silently writing to the dev DB.

First-time setup on a fresh clone:

```bash
createdb findash_test
bun run db:migrate:test   # apply drizzle migrations to findash_test
bun run db:seed:test      # seed accounts/categories/rules
```

After changing the schema, re-run `db:migrate:test` so the test DB stays
in sync with `findash`.

### Per-lane test database (parallel worktrees)

Git worktrees isolate the checkout and `node_modules`, but NOT the
database — two agents running `bun run test` concurrently against
`findash_test` corrupt each other's fixtures. Set `FINDASH_TEST_DB` to give
each lane its own database. The name MUST start with `findash_test` — any
other value aborts the run immediately.

```bash
createdb findash_test_x
# Mandatory — a freshly created DB defaults to the server timezone; without
# this ~2 consolidate tests fail on a date boundary.
psql -d findash_test_x -c "ALTER DATABASE findash_test_x SET timezone TO 'UTC';"

FINDASH_TEST_DB=findash_test_x bun run db:migrate:test
FINDASH_TEST_DB=findash_test_x bun run db:seed:test
FINDASH_TEST_DB=findash_test_x bun run test
```

Unset, `FINDASH_TEST_DB` defaults to `findash_test` exactly as before.

## Visual verification (Playwright)

For UI-affecting PRs, agents without human eyes available can capture
screenshots of every page and attach them to the PR body.

First-time setup on a fresh clone:

```bash
bun run test:e2e:install   # download headless chromium (~280 MiB)
```

Capture screenshots:

```bash
bun run dev                # in another shell, leave running
bun run test:e2e           # generates e2e/screenshots/*.png
```

The current spec (`e2e/screenshots.spec.ts`) is capture-only — no
assertions. It loads `/`, `/transactions`, `/budgets`, `/insights`,
`/settings` and writes full-page PNGs. Screenshots and `test-results/`
are gitignored; treat them as ephemeral artifacts. Functional E2E tests
with assertions are out of scope until needed; when added, follow the
same conventions cc uses (`cc/docs/E2E_TESTING.md`).

## Agent orchestration

Work reaches `main` through one of **two sanctioned routes**. Both obey the
same contract — issue-first, branch naming, commit format, PR/CI gate, gh
identity, test database. Pick by what you have available, not by preference.

**The orchestrator does not write code directly.** It delegates, then reviews
what came back. That rule is route-independent.

### Route A — Claude Code sub-agents

The four roles and their trigger criteria apply to **both** routes. Route A
invokes them as Claude Code sub-agents in `.claude/agents/`. Route B launches
them as opencode primary agents via `--agent`. The table below is the shared
contract.

Claude Code on this repo runs project-scoped sub-agents in `.claude/agents/`.
Each one knows the conventions, reads engram (50+ documented gotchas) at
start, and follows `AGENTS.md`.

| Agent                 | Role                                               | When to invoke                                                                                                                                                                        |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findash-explorer`    | Read-only digest                                   | BEFORE implementer when the task touches 4+ files, requires mapping affected modules, needs prior art from engram, or the issue scope is unclear. Skip for obvious tasks.             |
| `findash-implementer` | Code + tests + lint+typecheck + commit             | For EVERY code change. Turns a claimed issue into a branch ready to ship. Does NOT push, does NOT open PRs.                                                                           |
| `findash-reviewer`    | Read-only review (CRITICAL / WARNING / SUGGESTION) | BETWEEN implementer and shipper for non-trivial changes: db schema, queries, server actions, money logic, tenant-scoped data. Skip for docs-only, test-only, or mechanical refactors. |
| `findash-shipper`     | Push + PR + CI watch + auto-merge                  | AFTER implementer (and reviewer if applicable). Mechanical only — no new logic. Auto-merge per § "PR convention" rules.                                                               |

#### Standard flow

```
gh issue (claim) → findash-explorer  (if 4+ files or scope unclear)
                 → findash-implementer  (ALWAYS — do not write code directly)
                 → findash-reviewer     (non-trivial: db, money, tenant, server actions)
                 → findash-shipper      (ALWAYS — push + PR + merge)
```

#### Why this flow

- **The orchestrator does not know the 50+ gotchas** documented in engram for this repo. The sub-agents do — they `mem_search` first thing. Bypassing them = re-introducing bugs already paid for.
- **Role separation** keeps implementer out of architectural design (use `/sdd-new` for that) and keeps shipper out of logic changes.
- **Reviewer between implementer and shipper** catches semantic bugs that lint/typecheck/tests miss: tenant safety on JOINs, soft-delete pattern, money as bigint cents, Next.js 16 server-action quirks.

### Route B — delegated agents over Herdr

Claude Code runs inside a Herdr pane (`HERDR_ENV=1`) and
can spawn sibling agents of other models — opencode, codex, gemini and others —
each in its own tab, its own worktree, and its own database. On 2026-09-09
eleven issues went from claim to merged `main` this way, with opencode running
the Grok 4.6 profile doing the implementing and shipping.

Use this route when you want lanes running in parallel, or a second model's
judgement on a design. Route A remains valid and is simpler for a single lane.

#### Launch role-specialized

Route B lanes launch already wearing a role. The prompt then carries only the
objective, per § "Prompt design" below. Do not smuggle the role into the prompt
— that is the "map" that section measures as producing a worse result.

```bash
herdr agent start <lane> --kind opencode --pane <pane_id> -- --agent findash-implementer
```

Definitions live in `.opencode/agents/findash-{explorer,implementer,reviewer,shipper}.md`
and are committed. `.opencode/` is deliberately **not** gitignored (unlike
`.claude/`, which is per-user Claude Code config). A worktree does not contain
`.claude/agents/` — `.gitignore` drops it — so Route B cannot read Route A's
files without an `external_directory` grant. Do not add that grant. Use the
committed opencode definitions.

Leave `model` unset on these agents so the operator's profile applies. Do not
put them in `~/.config/opencode/opencode.json` — that file is the gentle-ai
base layer and `gentle-ai sync` overwrites it.

#### `--auto` plus deny-first

`opencode --auto` auto-approves anything **not explicitly denied**. Alone that
is wrong: a shipper lane would merge without asking. Each `findash-*`
definition therefore carries a deny-first permission block so the role is
safe unattended. `--auto` is then per-role: a reviewer in auto still cannot
edit, because its own definition forbids it.

Do not run a lane with `--auto` unless its definition already denies the
surfaces that role must not touch. Herdr forwards native args after `--`:

```bash
herdr agent start <lane> --kind opencode --pane <pane_id> -- --auto --agent findash-reviewer
```

What each role denies (last matching bash rule wins):

| Role               | Denied                                                                   | Why                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| explorer, reviewer | `edit`, mutating git/gh (`commit`/`push`/`merge`/`pr create`/`pr merge`) | Read-only. `edit: deny` also blocks the `write` and `apply_patch` tools (verified on opencode 1.18.30: there is no separate `write` permission key). |
| implementer        | `git push`, `gh pr create`, `gh pr merge`                                | Commits only. Shipper pushes.                                                                                                                        |
| shipper            | `gh pr merge`, force-push, `git push origin main`                        | Push + PR + CI are its job. Merge stays a deliberate parent/human action so `--auto` cannot squash-merge.                                            |

`read` is a separate key from `edit`, so `edit: deny` leaves reading intact.
Definitions do not set `external_directory` and do not hardcode operator
paths. Once the files are in the worktree, a lane should never leave it.

#### Same chain, orchestrator-driven

The orchestrator launches each stage as its own lane (same worktree, a new
`--agent`). It does not write code.

```
gh issue (claim) → findash-explorer  (if 4+ files or scope unclear)
                 → findash-implementer  (ALWAYS — do not write code directly)
                 → findash-reviewer     (non-trivial: db, money, tenant, server actions)
                 → findash-shipper      (ALWAYS — push + PR + CI; merge is a parent/human action)
```

Trigger criteria are the Route A table's. `findash-implementer` commits and
stops. It does not push or open PRs.

#### Review gate is not automatic

A Route B lane told to go "end to end" will skip the reviewer unless the
orchestrator inserts it. For non-trivial changes (db schema/queries, server
actions, money logic, tenant-scoped data) the orchestrator MUST insert a
reviewer stage before merge, and the implementing lane MUST stop at PR-open
rather than auto-merge. Mechanical refactors, docs-only, and test-only changes
keep skipping the reviewer, same as Route A.

#### Epic-phase PRs do not close the epic

A PR delivering one phase of a multi-phase epic uses `Part of #N`, never
`Closes #N` — otherwise the epic dies with remaining phases unwritten. That
PR also fails auto-merge condition (b) ("PR closes a single issue"), so it
stops at PR-open and waits for a human.

#### One lane, end to end

```bash
# 1. Worktree off current main
git worktree add -b claude/phase-4/<issue>-<slug> \
  ~/projects/personal-financial-dashboard-worktrees/<lane> main
# .env.local is gitignored — without this copy the worktree fails at runtime
cp .env.local ~/projects/personal-financial-dashboard-worktrees/<lane>/.env.local

# 2. Its own database — the timezone step is NOT optional (see § Test database)
createdb findash_test_<lane>
psql -d postgres -c "ALTER DATABASE findash_test_<lane> SET timezone TO 'UTC';"
FINDASH_TEST_DB=findash_test_<lane> bun run db:migrate:test
FINDASH_TEST_DB=findash_test_<lane> bun run db:seed:test

# 3. node_modules is NOT shared between worktrees
cd ~/projects/personal-financial-dashboard-worktrees/<lane> && bun install

# 4. One tab per agent — never a pane split of the orchestrator's tab
herdr tab create --cwd "$PWD" --label <lane> --no-focus     # -> pane_id
herdr agent start <lane> --kind opencode --pane <pane_id> --timeout 240000 \
  -- --agent findash-implementer
herdr agent prompt <lane> "<objective>" --wait --until idle --until done

# 5. Teardown the moment it merges — tab, worktree, branch, database
herdr tab close <tab_id>
git worktree remove ~/projects/personal-financial-dashboard-worktrees/<lane> --force
git branch -D claude/phase-4/<issue>-<slug>
dropdb findash_test_<lane>

# 6. If the lane shipped a migration, re-migrate the SHARED test database.
#    The lane's own database had it; you just dropped that one.
bun run db:migrate:test
```

> **Step 6 is the easy one to forget.** Skipping it leaves `findash_test`
> running the pre-merge schema, and the next full-suite run fails on tests that
> are green in CI. The symptom looks like a regression on `main` and is not one —
> check `drizzle.__drizzle_migrations` against `drizzle/meta/_journal.json`
> before debugging any code.

#### Prompt design: give the objective, not the route

Do **not** hand a delegated agent the repo's conventions. Measured on this repo:
an agent asked only _"what are this repo's conventions?"_, with no pointers,
independently read `AGENTS.md`, `PLAN.md`, `CLAUDE.md` and `docs/`, **queried
engram on its own**, and surfaced tenant safety, the money convention and the
gotchas — plus caught that `PLAN.md` is stale on auth and cron. The same agent
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

#### Operating parallel lanes

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

  Three gotchas:
  - **`pane_id` is required per subscription.** No wildcard. Omitting it fails
    with `invalid_request: missing field 'pane_id'`. One entry per pane.
  - **`agent_status` is a server-side filter.** Subscribe for `blocked` and
    `done` only; `working`/`idle` never hit the wire.
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

#### Which route for what

| Situation                                 | Route                                  |
| ----------------------------------------- | -------------------------------------- |
| Single lane, ordinary issue               | A or B — A is less setup               |
| Several independent issues at once        | B, one lane each                       |
| Want a second model to challenge a design | B — ask for the proposal, not the code |
| Architectural design from scratch         | `/sdd-new`, either route after         |

Other agents (Codex, etc.) driving this repo directly can ignore the routing
above — the rules elsewhere in this file (issue-first, branch naming, commits,
PRs, gh identity, testing) still apply to all agents equally.
