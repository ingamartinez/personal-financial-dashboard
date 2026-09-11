---
name: findash-testing
description: How to run findash tests without corrupting someone else's fixtures — the findash_test database rule, FINDASH_TEST_DB for parallel worktree lanes, the per-vitest-worker clone mechanism and why fileParallelism must stay on, the mandatory UTC timezone step, plus local commands and Playwright screenshot capture. Load before running the suite, adding a test, creating a worktree lane, or debugging a test that only fails locally.
---

# Findash testing


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

### Per-worker test databases (how the suite runs in parallel)

The suite runs with `fileParallelism` ON. That is only safe because every
vitest worker gets **its own database**: `vitest.global-setup.ts` clones
`<base>_w1 … _wN` from the base database with `CREATE DATABASE … TEMPLATE`
before the run and drops them after. A worker resolves its own name from
`VITEST_POOL_ID` (see `vitest.test-db-name.ts`).

This stacks with `FINDASH_TEST_DB` rather than replacing it — a lane pinned to
`findash_test_818` gets `findash_test_818_w1 … _w4`. Lane teardown is unchanged:
drop the base, the clones are already gone.

Three things to know before touching this:

- **The base database is the template.** `db:migrate:test` and `db:seed:test`
  still target it, and workers never connect to it during a parallel run.
  Postgres refuses a TEMPLATE copy while anything else is connected to the
  template, so an open `psql` session against it fails the run with a message
  saying exactly that.
- **`TEMPLATE` does not copy per-database settings.** They live in
  `pg_db_role_setting`, outside the template, so globalSetup re-applies
  `SET timezone TO 'UTC'` on every clone. Without it the clones inherit the
  server timezone and exactly two consolidate specs fail on a date boundary —
  the same failure a manual `createdb` produces without the ALTER.
- **Do NOT "fix" a flaky test by setting `fileParallelism: false`.** That was
  the old configuration and it cost 87s serial against ~15s parallel (measured
  in #912). It also hides real cross-test coupling instead of surfacing it. If a
  test only passes serially, it is reading state another test owns — fix that.

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

