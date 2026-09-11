---
name: findash-review
description: The findash semantic review checklist — tenant safety on per-user JOINs, soft-delete via notDeleted(), money as bigint cents, formatAccountLabel, Pino logger discipline, Next.js 16 "use server" and async-API rules, drizzle migration sanity, test conventions — plus the CRITICAL/WARNING/SUGGESTION report format the orchestrator routes on. Load when reviewing a diff, or when self-reviewing before opening a PR.
---

# Findash review checklist

These are the recurring bugs in findash: the ones lint, typecheck and tests do
not catch. Check every rule below against the diff under review, and only the
diff — pre-existing code is out of scope unless the diff makes it materially
worse.

Three rules govern the output:

1. **Every finding is CRITICAL, WARNING or SUGGESTION.** If it fits none of the
   three, it is not a finding. Drop it.
2. **No style nitpicks.** ESLint and Prettier own style.
3. **Cite the rule.** A finding the implementer cannot verify is noise.

## The convention checklist

These are the recurring bugs in findash. Check each rule against the diff:

#### Database / queries
- [ ] Per-user tables (`categories`, `budgets`, `rules`, `transactions`, etc.): JOINs MUST pair on `user_id`, not just `slug`. Cross-tenant leak risk (#336, #338).
- [ ] Soft-delete tables (those with `deleted_at`): use `notDeleted()` from `src/lib/db/helpers.ts`. NEVER `db.delete()`. Action names start with `archive*`, never `delete*`.
- [ ] New table with `deleted_at`: must add a partial sibling index (`WHERE deleted_at IS NULL`).
- [ ] Drizzle `sql` template (not raw strings) inside `.where()`, `.default()`.
- [ ] FK to non-PK columns: inline `.unique()` on the column. NOT `uniqueIndex(...)` after — that breaks FK ordering.
- [ ] BigInt defaults: `sql\`0\``, NOT `0n` (drizzle-kit chokes on BigInt JSON).
- [ ] If schema changed: was `bun run db:generate` run? Is `_journal.json.when` monotonic? (`jq` validation).

#### Money
- [ ] Currency stored as `bigint amount_cents`. NEVER float, NEVER number for money.
- [ ] Conversions to display use the documented helper, not inline math.

#### Account labels
- [ ] Anywhere an account is shown to the user: `formatAccountLabel(account)`. NEVER inline `account.name`.

#### Logger / observability
- [ ] No `console.log/.error/.warn/.debug/.info` ANYWHERE — `src/`, `scripts/`, `instrumentation.ts`, seeds. ESLint blocks this but the reviewer flags it as a CRITICAL convention violation.
- [ ] Module starts with `import { createLogger } from "@/lib/logger"; const log = createLogger({ module: "..." });`.
- [ ] Errors logged with `log.error({ err, ...fields, event: "thing_failed" }, "thing failed")`. NEVER concatenate user input into the message string. The Pino `err` serializer is what defeats CodeQL `js/log-injection`.

#### Next.js 16
- [ ] `cookies()`, `headers()`, `params`, `searchParams` are AWAITED.
- [ ] Files with `"use server"` directive: ALL exports are `async` functions. Type guards / Zod schemas / non-async exports go in a sibling file (e.g., `actions-types.ts`).
- [ ] No module-level env-throw in any module that a route imports — breaks `next build`. Stub env in CI.
- [ ] Middleware lives at `src/proxy.ts` (renamed from `middleware.ts`).

#### Tests
- [ ] Integration tests hit `findash_test` (not mocks). `vitest.setup.ts` forces this — flag if a new test mocks the DB.
- [ ] React component tests start with `// @vitest-environment jsdom` as the FIRST line of the file.
- [ ] Factories shared across mocks use `vi.hoisted(() => ({ ... }))` (factories inside `vi.mock(...)` are hoisted above top-level consts).
- [ ] Radix component tests have pointer-capture + scrollIntoView shims.

#### PR / commit hygiene
- [ ] Commit subjects follow `<type>(<scope>): <subject> (#<issue>)`.
- [ ] No `Co-Authored-By` or AI attribution lines.
- [ ] `gh` calls use `GH_CONFIG_DIR=~/.config/gh-findash` (if any docs/scripts added).

## Cite what justifies each finding

For every finding you flag, cite the engram memory or AGENTS.md section that justifies it. This makes the report auditable — the implementer can verify the rule, not just take your word for it. Use the engram MEMORY TITLE in your output (memory IDs are not user-friendly; titles are).

If you find a NEW gotcha not yet documented in engram, flag it as 🔵 SUGGESTION and recommend the orchestrator save a memory after the PR ships. Do NOT save the memory yourself — that's the orchestrator's call.

## Categorise

| Bucket | Meaning | Examples |
|---|---|---|
| 🔴 CRITICAL | Must fix before merge — production risk or correctness bug | tenant leak (JOIN missing user_id), money in float, soft-delete bypass, console.* in prod path, server action exporting non-async type |
| 🟡 WARNING | Should fix — convention violation, minor risk, code smell | missing logger import, inline `account.name`, missing partial index on new soft-delete table, missing test for new query |
| 🔵 SUGGESTION | Consider — improvement, optimization, doc gap | could batch a query, missing JSDoc on a public helper, candidate engram memory to save |

If a finding doesn't fit any of these three, it's not a finding. Drop it.

## Report format

Use this exact structure:

```markdown
# Reviewer report — <branch> (closes #<N>)

## Status
<APPROVE | NEEDS_FIXUP | SKIP — with one-line reason>

## Summary
<2-3 sentences: what was reviewed, the headline verdict, count by bucket (e.g., "1 CRITICAL, 2 WARNING, 1 SUGGESTION")>

## 🔴 CRITICAL — must fix before merge
- **<one-line title>** at `path/to/file.ts:42-58`
  - **What**: <the bug, in one sentence>
  - **Why critical**: <consequence — production risk, correctness, security>
  - **Reference**: engram memory "<title>" / AGENTS.md § <section>
  - **Suggested direction**: <one-line how, NO code>

(repeat for each)
(omit the section entirely if zero CRITICAL findings)

## 🟡 WARNING — should fix
(same shape)
(omit if zero)

## 🔵 SUGGESTION — consider
(same shape)
(omit if zero)

## Engram references consulted
- "<memory title>" — applied because <reason>
- ...

## Out of scope (noted but not flagged)
- <things you noticed in pre-existing code, scope creep, etc.>
- (omit if none)
```

The `Status` line is the most important. The orchestrator routes based on it:

- `APPROVE` → 0 CRITICAL → orchestrator runs `scripts/ship.sh`
- `NEEDS_FIXUP` → ≥1 CRITICAL → orchestrator bounces back to implementer with the report
- `SKIP — <reason>` → not applicable (docs/tests/refactor/dep bump) → orchestrator runs `scripts/ship.sh`

WARNING-only does NOT block merge by default. The orchestrator decides whether to bounce on warnings based on context.
