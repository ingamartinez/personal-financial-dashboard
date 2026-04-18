# Multi-user migration plan

**Status**: decision record — no code in this doc. Written 2026-04-17 as the planning layer for issue #179 (multi-user public deploy for ~5 friends).

Closes the decision-record scope of:

- #149 — document single-user assumption + plan migration path
- #150 — evaluate NextAuth for exposure beyond Tailscale

Implementation is tracked as separate issues (see [Sub-issues to open](#sub-issues-to-open) at the end).

---

## 1. Context

Findash today is single-user, Tailscale-only, single Telegram bot. Every user-owned table (`accounts`, `transactions`, `categories`, `classification_rules`, `counterparties`, `counterparty_aliases`, `budgets`, `recurring_transactions`, `recurring_gaps`, `account_snapshots`, `ingestion_logs`, `insights_reports`, `telegram_sessions`, `telegram_poll_state`) assumes a single implicit owner and carries no `user_id`.

The trigger to change this is #179: share the app with ~5 friends, each with their own Google account and their own Telegram bot, on a public Droplet.

This document is the explicit architectural decision for how that migration happens.

## 2. Decisions

### 2.1 Authentication — NextAuth v5 + Google OAuth

- Provider: **NextAuth v5 (Auth.js) with the Google provider only**.
- Sessions: server-side JWT session cookie (HttpOnly, Secure, SameSite=Lax).
- Google gives us `sub` (stable account id), verified `email`, `name`, `picture`. We store all four.
- No password auth, no other providers. Scope stays minimal.
- Middleware protects every route except `/signup`, `/login`, `/api/auth/*`, and `/api/telegram/webhook/:botId` (webhook auth is its own signed path — see §2.6).

Rationale: one trusted provider, zero credential storage, email-verified identities, widely familiar to the target audience (5 friends, all on Google). Closes #150.

### 2.2 Registration — invite-code gated

- A new `invite_codes` table controls who can sign up. Open signup is **off**.
- First user (me) is bootstrapped via a one-shot SQL insert during deploy.
- Subsequent users sign up via `/signup?code=XYZ` → Google OAuth → code validated + consumed → user row created → signed in.
- Codes have `max_uses`, `uses_count`, optional `expires_at`, and `created_by_user_id` (who issued the invite). Single-use by default.
- A small `/settings/invites` page lets any authenticated user mint codes (initially restricted to me; can be opened up later with a `role` column if needed).

Rationale: 5 friends deserve explicit provisioning, not a public URL that any Google user can sign up against. Invite codes are cheap, auditable, and easy to revoke.

### 2.3 Tenant scoping — application-layer with denormalized `user_id`

**Decision: application-layer filtering with `user_id` denormalized on every tenant-scoped table.** Postgres Row-Level Security (RLS) is deferred as an optional phase-2 hardening.

| | App-layer (chosen) | RLS |
|---|---|---|
| Enforcement | Every query includes `WHERE user_id = $userId` | Postgres enforces per-session |
| Bug risk | One missed `where` → cross-tenant leak | Defense in depth |
| Debugging | Queries are explicit, easy to trace | Hidden predicates, harder to reason about |
| Drizzle ergonomics | Native (where clauses are already typed) | Needs `SET LOCAL app.user_id` per connection; postgres.js pooling complicates this |
| Complexity cost | Low — one helper | High — roles, policies, connection session management |

Why app-layer is enough for this scope:
- Single codebase, single developer, 5 trusted users.
- All writes go through server actions or API routes — one entry layer to audit.
- A single `getSessionUser()` helper returns the typed `userId` and is the ONLY way to access `user_id` in query builders. Queries that don't take `userId` are code-review-obvious violations.
- Integration tests (Vitest) will assert isolation: create two users, insert rows for each, verify queries scoped to user A never return user B's rows.

Why RLS is deferred, not rejected:
- If the user base ever grows past the trusted circle, adding RLS on top of `user_id` columns is a pure policy-layer change — no schema rework needed. The denormalized `user_id` makes that upgrade path cheap.

### 2.4 `user_id` denormalization even when derivable via FK

Tables like `transactions`, `account_snapshots`, `recurring_gaps`, `counterparty_aliases` have a parent FK that is already user-scoped (e.g. `transactions.account_id → accounts.user_id`). We could leave these without a `user_id` and always join.

**We denormalize instead.** Every tenant-scoped table gets its own `user_id` column.

Reasons:
- Composite indexes like `(user_id, occurred_at)` only work if `user_id` is on the same table. Dashboard queries scan `transactions` by date range without an `account_id` filter (see `src/lib/dashboard/queries.ts`) — without a direct `user_id` they'd have to join accounts on every query.
- App-layer filtering stays uniform: every query is `WHERE user_id = $userId`, never `WHERE account.user_id = $userId`.
- Future RLS policies apply cleanly without multi-hop predicates.
- Cost is one integer column and one invariant: "rows inherit user_id from their parent". Enforced at insert-time by the server action that creates them.

### 2.5 Classification rules — per-user, copy-on-signup

Current state: `classification_rules` is scanned per-transaction at ingest via `ILIKE` pattern matching (`src/lib/classification/rules.ts`). No user scope.

Options considered:
- **A** — keep rules global: rejected, users would see each other's patterns affect their classification.
- **B** — `user_id NULLABLE`, global seed + per-user overrides by priority: rejected, query becomes `WHERE (user_id = $1 OR user_id IS NULL)` which defeats the composite index and adds cognitive load.
- **C** — rules are fully per-user; on signup, **copy the seed set** from a global `classification_rule_seeds` table into that user's rules: **chosen**.

Rationale: rules are preferences, not taxonomy. Each user will tune rules for their own banks, merchants, and Telegram habits. Copy-on-signup gives a sane starting point without cross-user coupling, and rule drift per user is desirable.

### 2.6 Categories — stay global

Current state: `categories` is a seed table (shared taxonomy). Rejected making it per-user.

- Five friends agree on categories (food, transport, subscriptions, etc.).
- Keeping it global enables future cross-user comparisons ("who spends more on coffee") without a taxonomy-mapping layer.
- No signup UX needed — users land with categories already populated.
- If anyone demands custom categories, we add `user_id NULL` later (NULL = global, non-NULL = user's own). The table design accepts that migration cheaply.

### 2.7 Telegram multi-bot — deferred to its own issue

The current polling worker in `instrumentation.ts` can only serve one bot token. Multi-user means either (a) one bot serving many users (rejected — friends want privacy and independent botfather tokens) or (b) each user registers their own bot, webhook-routed.

Decision: **webhook architecture, one bot per user**, tracked in a separate implementation issue (§10). This doc commits only to the schema shape — the new tables are:

```
telegram_bots (
  id, user_id, token (encrypted), username, webhook_secret, created_at
)
```

`telegram_sessions` gets `user_id` (replacing the current implicit single-user assumption). `telegram_poll_state` is deleted when we migrate off polling.

## 3. Target schema

### 3.1 New tables

```sql
-- users: one row per Google-authenticated person
users (
  id           serial PRIMARY KEY,
  google_sub   varchar(255) NOT NULL UNIQUE,   -- Google's stable subject id
  email        varchar(320) NOT NULL UNIQUE,   -- verified by Google
  name         varchar(200) NOT NULL,
  picture_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
)

-- invite_codes: gate on signup
invite_codes (
  code                varchar(32) PRIMARY KEY,  -- human-friendly, e.g. nanoid
  created_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  max_uses            integer NOT NULL DEFAULT 1,
  uses_count          integer NOT NULL DEFAULT 0,
  expires_at          timestamptz,              -- NULL = never
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (uses_count <= max_uses)
)

-- classification_rule_seeds: template rules copied on signup
classification_rule_seeds (
  id             serial PRIMARY KEY,
  pattern        text NOT NULL,
  category_slug  varchar(60) NOT NULL REFERENCES categories(slug),
  priority       integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now()
)

-- telegram_bots: one row per user's bot (phase 2.7)
telegram_bots (
  id              serial PRIMARY KEY,
  user_id         integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token_encrypted text NOT NULL,
  username        varchar(64) NOT NULL,
  webhook_secret  varchar(64) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
)
```

### 3.2 Tables getting `user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE`

| Table | Parent-derivable? | Why denormalize anyway |
|---|---|---|
| `accounts` | N/A (root) | — |
| `transactions` | via `account_id` | `(user_id, occurred_at)` is the hot index for dashboards |
| `classification_rules` | N/A | per-user rules, always filter by user |
| `counterparties` | N/A | per-user merchant memory |
| `counterparty_aliases` | via `counterparty_id` | unique `(user_id, kind, value)` replaces global `(kind, value)` |
| `budgets` | via `category_slug` (shared) | budgets are per-user, must be direct |
| `recurring_transactions` | via `account_id` | hot queries by user + `day_of_month` |
| `recurring_gaps` | via `recurring_id → account_id` | keeps gap queries simple |
| `account_snapshots` | via `account_id` | simplifies "my net worth over time" |
| `ingestion_logs` | N/A | per-user ingestion visibility |
| `insights_reports` | N/A | per-user monthly reports |
| `telegram_sessions` | N/A | replaces implicit single-user assumption |

The existing `telegram_sessions.user_id` column is **Telegram's user id** (a `bigint` from the Telegram API), not Findash's. It will be renamed `telegram_user_id` and a new `user_id integer NOT NULL REFERENCES users(id)` is added.

### 3.3 Tables staying global

| Table | Reason |
|---|---|
| `categories` | shared taxonomy (§2.6) |
| `classification_rule_seeds` | new, template rules to copy on signup |
| `fx_rates` | reference data |
| `users` | obvious |
| `invite_codes` | obvious |

`telegram_poll_state` is deleted as part of the webhook migration (§2.7).

## 4. Migration strategy

Single-user bootstrap (the author) is row `user_id = 1`. All existing data is backfilled to that row. New users get `id >= 2`.

Sequenced steps — each a separate drizzle migration + a separate PR:

1. **Create auth infrastructure**
   - Add `users` and `invite_codes` tables (empty).
   - Add `classification_rule_seeds` and seed it from the current global `classification_rules` rows.
   - Install NextAuth, configure Google provider, wire up `/api/auth/[...nextauth]`.
   - Do **not** gate any routes yet.

2. **Bootstrap the first user**
   - Deploy migration #1.
   - One-shot SQL: `INSERT INTO users (google_sub, email, name) VALUES (<my google sub>, <my email>, <my name>)` — returns `id = 1`.
   - Mint my first invite codes manually.

3. **Add nullable `user_id` columns**
   - Generate migration adding `user_id integer REFERENCES users(id)` to every table in §3.2, nullable.
   - No FK violations because existing rows have NULL; no app changes yet.

4. **Backfill**
   - `UPDATE <table> SET user_id = 1 WHERE user_id IS NULL` for every tenant-scoped table.
   - Verify zero NULLs on each.

5. **Tighten the constraint**
   - `ALTER COLUMN user_id SET NOT NULL` on every tenant-scoped table.
   - Add `ON DELETE CASCADE` where not already present.

6. **Swap indexes** — see §5 for the full table.

7. **Rewrite queries**
   - Create `getSessionUser()` helper that returns `{ userId: number, email, name }` from the NextAuth session.
   - Audit every Drizzle query in `src/`: every user-table query must `WHERE user_id = sessionUser.userId`.
   - Ingest paths (Telegram webhook, SMS, OCR, CSV) resolve `userId` from the bot/session/request context, never from a client-supplied body field.
   - Add Vitest integration test: two users, each gets fixture data, assert zero cross-tenant reads.

8. **Gate routes**
   - NextAuth middleware on every `/app/**` route and every server action.
   - Public exceptions: `/signup`, `/login`, `/api/auth/*`, `/api/telegram/webhook/:botId`.

9. **Signup flow**
   - `/signup?code=XYZ` validates the code server-side, stores it in a signed cookie, initiates Google OAuth. On callback, consume the code atomically (`UPDATE invite_codes SET uses_count = uses_count + 1 WHERE code = $1 AND uses_count < max_uses RETURNING *`), create the `users` row, copy `classification_rule_seeds` → `classification_rules` with new `user_id`, sign the user in.

10. **Telegram multi-bot** (separate issue): migrate polling → webhooks, per-user bots, `telegram_bots` table.

11. **Public deploy** (separate issue): DO Droplet, domain, Caddy, CI/CD.

Steps 1-9 are the scope of the multi-tenancy implementation issue. Each is small enough to land as its own PR with its own CI green, minimizing risk.

## 5. Index changes

| Table | Current | After migration | Notes |
|---|---|---|---|
| `transactions` | `(account_id, occurred_at)`, `(category_slug)`, `(counterparty_id)`, `(occurred_at)` | add `(user_id, occurred_at)`; replace `(category_slug)` with `(user_id, category_slug)`; replace `(counterparty_id)` with `(user_id, counterparty_id)`; drop bare `(occurred_at)` | dashboard time-range scans need user prefix |
| `transactions_external_unique` | `(account_id, external_id) WHERE external_id IS NOT NULL` | unchanged | account_id is already user-scoped via accounts.user_id FK |
| `transactions_recurring_unique` | `(recurring_id, year_month)` | unchanged | recurring_id is already user-scoped |
| `classification_rules` | `(priority)` | `(user_id, priority, id)` | matches ingest-time ILIKE scan ordering |
| `counterparty_aliases` | **unique `(kind, value)`** | **unique `(user_id, kind, value)`** | **critical** — current global unique will conflict across users |
| `budgets` | none | `(user_id, period_start)` | budget list query |
| `recurring_transactions` | none | `(user_id, day_of_month)` | cron-style queries |
| `recurring_gaps` | unique `(recurring_id, year_month)`, `(detected_at)` | add `(user_id, detected_at)`; keep others | user-visible gap list |
| `accounts` | none | `(user_id, active)` | account list query |
| `counterparties` | none | `(user_id, display_name)` | counterparty search |
| `account_snapshots` | unique `(account_id, snapshot_date)` | unchanged (account_id already user-scoped) | |
| `ingestion_logs` | none | `(user_id, started_at)` | per-user log view |
| `insights_reports` | unique `(year_month)` | replace with unique `(user_id, year_month)` | one report per user per month |
| `telegram_sessions` | PK `(chat_id)` | add `(user_id)` non-unique | session cleanup by user |

## 6. Query rewrite strategy

The rewrite is mechanical but wide. Plan:

1. Add `getSessionUser()` in `src/lib/auth/session.ts`. It's the ONLY way to obtain `userId` outside of webhook/ingest paths.
2. Introduce a repo-wide lint rule or convention: **no direct Drizzle queries on tenant-scoped tables without a `where user_id = ` predicate.** Easiest enforcement is code review + integration tests, not static analysis.
3. Audit in this order (hot paths first):
   - `src/lib/transactions/queries.ts`
   - `src/lib/dashboard/queries.ts`
   - `src/lib/classification/rules.ts` and `pipeline.ts`
   - `src/app/api/ingest/**/route.ts`
   - `src/lib/recurring/**`
   - `src/app/**/actions.ts`
   - `src/lib/ingestion/**`
4. Ingest paths resolve `userId` from context, not from request bodies: Telegram webhook → `telegram_bots.user_id`, SMS → bot session → user_id, OCR → logged-in user.
5. Integration test per hot path: two-user fixture, assert cross-tenant isolation.

## 7. Effort estimate

Assuming single dev, focused days (not calendar days):

| Phase | Effort |
|---|---|
| Auth + session plumbing (NextAuth + Google + middleware) | 1.5 days |
| Schema migrations 1-5 (create users, invite_codes, add user_id, backfill, NOT NULL) | 1 day |
| Index swap (migration 6) | 0.5 day |
| Query rewrite (migration 7) across all hot paths | 2-3 days |
| Signup flow with invite codes | 1 day |
| Integration tests for cross-tenant isolation | 1 day |
| Telegram multi-bot webhook migration (separate issue) | 2-3 days |
| DO deploy + CD (separate issue) | 1-2 days |
| Buffer for surprises | 1-2 days |
| **Total (this plan's scope: steps 1-9)** | **7-9 days** |
| **Total including telegram + deploy** | **10-14 days** |

## 8. Risks and open questions

- **Google OAuth consent screen setup**: personal Google Cloud project needs an OAuth consent screen. For "external" user type with <100 users, verification is optional but the warning screen is visible. Acceptable for 5 friends.
- **Invite code delivery**: how do I give friends their code? Manually via WhatsApp/Telegram is fine for 5 people; no UI needed beyond `/settings/invites` minting.
- **Bot token encryption at rest**: `telegram_bots.token_encrypted` needs a symmetric key stored outside the DB (env var). Pick `aes-256-gcm` with a key rotation plan documented when that issue opens.
- **Session invalidation**: if a user is removed (revoke access), their JWT session stays valid until expiry. Acceptable short-term; add a `user.active` boolean later if needed.
- **Data export / account deletion**: GDPR not a legal issue for 5 friends in CO, but `ON DELETE CASCADE` means deleting a user wipes everything. Document this; consider a "soft delete" flag before go-live if friends request data portability.
- **Rule seed drift**: once seeds are copied to a user, upstream seed changes don't propagate. This is intentional (§2.5) but document it so future-me doesn't expect seed updates to apply retroactively.

## 9. Sub-issues to open

After this doc lands:

1. **feat(auth): NextAuth v5 + Google OAuth + session middleware** — implements §2.1, §2.2, step 1, step 8.
2. **feat(db): add users, invite_codes, classification_rule_seeds tables + bootstrap user 1** — implements steps 1-2.
3. **feat(db): multi-tenancy migration — user_id on all tenant tables + query rewrite** — implements steps 3-7, §5, §6.
4. **feat(auth): invite-code signup flow** — implements §2.2, step 9.
5. **feat(telegram): migrate polling → webhooks with per-user bots** — implements §2.7, step 10.
6. **infra(deploy): DigitalOcean Droplet + GitHub Actions CD** — implements step 11.

Each opens with a link back to this doc as the canonical design reference.
