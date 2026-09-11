# Phase 7 SaaS seam — audit

> Issue #922, task 12. Audited 2026-09-11. **This is a report, not a change.**
> Nothing was dropped. Dropping a column is irreversible against production
> data; nullable unused columns are not.

## Why this audit exists

The seam was justified by one premise, stated at the top of the old `PLAN.md`:

> "Findash arranca como herramienta personal … pero el objetivo a largo plazo es
> escalarla como producto rentable."

That premise was withdrawn on 2026-09-11:

> "ya me rendí con que sea un producto rentable dado lo complicado y muy
> enfocado a mis necesidades."

Everything below was built to serve a goal that no longer exists. The question
this audit answers is not "is it justified?" — it is not — but **"what does it
actually cost to leave it there?"** Those are different questions, and for this
seam the answers point in opposite directions.

## What the seam is

### 1. Four columns on `users`

| Column | Type | Nullable | Rows with a value |
| --- | --- | --- | ---: |
| `subscription_status` | `varchar(20)` | yes | **0** |
| `plan_id` | `varchar(40)` | yes | **0** |
| `trial_ends_at` | `timestamptz` | yes | **0** |
| `mercadopago_customer_id` | `varchar(80)` | yes | **0** |

Nothing in `src/` or `scripts/` reads or writes any of them. Their only
occurrence outside the migrations is their own declaration in `schema.ts:160-163`.

### 2. `canIngest(userId)` — `src/lib/auth/can-ingest.ts`

Returns `{ allowed: true }` unconditionally. Called from three ingest routes:

- `src/app/api/ingest/sms/route.ts:29`
- `src/app/api/ingest/ocr/route.ts:15`
- `src/app/api/telegram/webhook/[botId]/route.ts:67`

`paywallResponse()` (HTTP 402) is reachable from all three and has never fired.

### 3. `canAccessFeature(userId, feature)` — `src/lib/auth/can-access-feature.ts`

Returns `true` unconditionally. One production caller,
`src/lib/insights/savings-suggestions.ts:25`, gating `cdt-suggestion` and
`fic-suggestion`.

Unlike the columns, **this one has real test coverage of its false branch** —
two specs in `savings-suggestions-detector.test.ts` assert that a suggestion is
suppressed when the gate denies. Those tests exercise a code path that cannot
occur in production.

## What it costs

| | Cost | Measured |
| --- | --- | --- |
| Storage | **0 bytes** | `users` is 64 kB with 5 rows. The table already carries nullable columns (`picture_url`), so the per-row null bitmap already exists; four more always-NULL columns add null bits inside a byte-aligned bitmap that is already allocated. |
| Runtime | **~0** | one `async` call returning an object literal, on three ingest paths. Not a query. |
| Query complexity | **none** | no query filters, joins or indexes touch these columns. |
| Cognitive | **2 `eslint-disable` lines**, 2 explanatory comments, and this file. A reader who meets `canIngest` has to learn it is a no-op before moving on. |
| Test | **2 specs of 3,384** exercise a branch that cannot happen. |

## What is genuinely dead

**The four columns.** Zero readers, zero writers, zero rows. They are the only
part of the seam that is dead in the strict sense — the two functions are alive
and called, they just always say yes.

## Recommendation

**Leave all of it. Do not open a migration.**

The reasoning is asymmetric, and that asymmetry is the whole argument:

- Leaving the columns costs **zero measurable bytes and zero runtime**. The
  entire cost is two `eslint-disable` comments, which this file now explains.
- Dropping them requires a migration against production. A `DROP COLUMN` on a
  live database is not reversible by rolling back the deploy — the data is gone,
  and `drizzle` will not put it back. That is a real risk paid to remove a cost
  measured at zero.

An action with a nonzero downside taken to remove a zero cost is a bad trade,
regardless of whether the original justification still stands. **"No longer
justified" and "worth removing" are not the same finding**, and this seam is the
first without being the second.

### If the columns are dropped anyway

That is the operator's call, and it needs explicit sign-off. The order that is
safe:

1. Back up `users` off-host (`docs/deploy.md` § backup/restore).
2. Drop `mercadopago_customer_id` first — it is the only one naming a vendor
   that was never integrated, so it is the least likely to be wanted back.
3. Leave `trial_ends_at`. It is the one column with a plausible non-SaaS use
   (a time-boxed anything), and it is a bare timestamp.

### What is worth changing, and is not a migration

The two specs asserting `canAccessFeature === false` test an impossible state.
They are cheap and harmless, but if the Premium tier is formally abandoned they
should be deleted along with the `PremiumFeature` union — a **code** change, no
database involved, and fully reversible. Not done here: this task was scoped to
report.

## Explicitly NOT part of this seam

The **closed-beta invite system** (`invite_codes`, `/signup`, `/admin/invites`,
`src/lib/invite-codes/`) is Phase 4.5, not Phase 7. It is fully wired, in use,
and is how the operator's own account and his friends' accounts exist. It is not
touched by this audit and should not be.
