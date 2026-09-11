---
name: findash-tech-baseline
description: Findash stack rules that are easy to get wrong — Next.js 16 async APIs and "use server" constraints, Drizzle sql`` templates and FK ordering, money as bigint amount_cents, the Pino logger contract (console.* is blocked everywhere), BullMQ for all background work, Vitest jsdom setup. Load before writing or reviewing any code in src/, scripts/, or instrumentation.ts.
---

# Findash tech baseline

Do not deviate from anything here without opening an issue first.

## This is NOT the Next.js you know

Next.js 16 has breaking changes vs older versions — APIs, conventions, and file
structure may differ from training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.


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
- **Background work**: Anything that runs outside the request lifecycle MUST go through `src/lib/queue` (BullMQ + Redis). Forbidden patterns: `setInterval`, `cron.schedule` (`node-cron` is removed from the project), `queueMicrotask` for async work, `after()` for anything beyond canary metrics. Cron schedules go in BullMQ as `{ repeat: { pattern: "0 3 * * *", tz: "America/Bogota" }, jobId: "<name>-recurring" }` — the `jobId` makes re-scheduling on restart idempotent. Dashboard at `/admin/queues` (requires admin role, `requireAdmin` gate). All workers use `createWorker(name, processor)` from `src/lib/queue/index.ts` — Pino logger + graceful shutdown wired in. Active queues: `fx-refresh`, `classify-tx`, `recurring-gap`, `health-snapshots`, `slo-alerts`, `gmail-pull`, `classify-ask`.
- **Recurring auto-link cold-start (accepted trade-off, #804)**: `src/lib/recurring/auto-link.ts`'s `resolveCandidate()` and `src/lib/recurring/gap-detector.ts`'s `resolveTxWinner()`/`resolveBijectiveGroups()` treat a recurring (or a group of indistinguishable recurrings) with **zero learned description-fingerprint patterns** as "nothing to contradict" and trust a same-account + exact-amount + in-window match on ANY tx description — including one that doesn't look related at all. This is deliberate, not a bug: it's bounded (blocked the moment the amount also collides with another active recurring, or after ~2 observations teach a real pattern) and reversible (one-tap "Deshacer match" in `/recurring`). Do NOT require a learned pattern before trusting this path — that would break every brand-new recurring's first month. See engram `architecture/804-*` for the full rationale before touching this logic.

