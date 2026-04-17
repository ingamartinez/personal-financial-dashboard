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
- **Auto-merge authorization**: AI agents may squash-merge their own PR into `main` without asking when ALL of: (a) typecheck passes, (b) lint passes, (c) smoke test passes (manual or automated), (d) PR closes a single issue, (e) no merge conflicts with `main`. Otherwise, ask the user before merging.

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
| `docs`                                     | Documentation only                                                                                                                                                                                                                                                                                                                                                                 |
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
- **Tests**: Vitest (when added). Co-locate `*.test.ts` next to source.

## Multi-agent etiquette

- One issue → one agent at a time. Claim by commenting on the issue.
- If you find related work in progress, leave a comment on the OTHER agent's issue instead of opening a parallel branch.
- Never force-push to `main`. Never bypass hooks.
- If you discover a non-obvious gotcha, save it to engram (`mem_save`) AND add it to the relevant section of this file.
- After running scaffolders or codegen (`shadcn init/add`, `bunx create-*`, drizzle generators, etc.), run `git log -1` BEFORE committing manually. Some tools auto-create commits with non-conventional messages (e.g. `shadcn init -y` produced `feat: initial commit` here). If you find an unauthorized commit on your branch, `git reset --soft HEAD~1` and rebuild it with the proper `<type>(<scope>): <subject> (#<issue>)` format. Never push these auto-commits.

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

## Test database (findash_test)

Integration tests DELETE rows during cleanup, so they MUST run against a
separate database. `vitest.setup.ts` forces `PGDATABASE=findash_test`
before any test imports — this cannot be overridden by `.env.local` or
shell env. If the setup ever fails to apply, tests abort loudly instead
of silently writing to the dev DB.

First-time setup on a fresh clone:

```bash
createdb findash_test
bun run db:migrate:test   # apply drizzle migrations to findash_test
bun run db:seed:test      # seed accounts/categories/rules
```

After changing the schema, re-run `db:migrate:test` so the test DB stays
in sync with `findash`.

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
