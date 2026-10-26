---
name: findash-finance-agent
description: How to answer "how are my accounts / what is left to pay / why does X look wrong" from the prod database instead of the web UI — read-only access, cross-checking Gmail and the bank's own export, and repairing data only through the app's own logic with a dry run first. Load when the user asks about their money, balances, recurrings or a transaction that looks off.
---

# Findash finance agent

The user does not open the web app. They ask in chat, and the agent answers
from prod, cross-checking every source the app ingests. The app's views can
look right and still be wrong — the agent's job is to notice.

## Reading prod

Connection and host: `docs/deploy.md` (SSH key, `sudo -u findash psql -d findash`).
Every session starts with `set default_transaction_read_only = on;` so no
exploratory query can write. Resolve the user id from `users` first and filter
every query by it. Reusable queries: `queries.sql` next to this file.

- "Paid" for a recurring = a live tx with `recurring_id` + `recurring_year_month`
  for that month. A missing link is not proof of non-payment — search unlinked
  txs by amount and description before saying something is overdue.
- Account balance is `derivedBalanceCentsSql` (`src/lib/accounts/queries.ts`):
  latest `account_snapshots` row + later txs, else the sum of all live txs.
  Compute it that way, never a hand-rolled sum, before comparing with the bank.
- The repo is public. Issues and PRs built from prod data carry tx ids and
  description shapes — never amounts, account suffixes or people's names.

## Evidence beyond the database

| Question | Source |
| --- | --- |
| Was a PSE payment approved, and its CUS | Gmail `from:serviciopse@achcolombia.com.co` (not ingested by the app) |
| Did money leave a Bancolombia account | The bank's own movements export the user downloads — PSE rows carry the CUS as reference |
| Bill amount / overdue months | The biller's invoice email (e.g. EPM `FactDigital`) |
| Real balance today | Ask the user. Never infer it. |

Facts only the user knows (paid early, rejected payment, which account): ask
one question, then continue.

## Writing to prod

1. **Never** ad-hoc `UPDATE`/`DELETE`. Writes go through the same library calls
   the app's action uses (link: set link + `recordRecurringLinkObservation` +
   close gap; unlink: clear link + reopen gap + `retractRecurringLinkObservation`;
   archive: `deleted_at`; balance: `adjustAccountBalance`'s insert).
2. Recurring repairs that touch many rows are a committed, fixed-id script with
   `--dry-run` that aborts on unexpected state (`scripts/repair-*.ts`), shipped
   through an issue + PR. A single-row fix may run as a temp file in the
   release dir, deleted right after.
3. Dry run, read the plan line by line, then apply, then verify with a query.
4. After `backfill-retokenize-patterns.ts`, list every tx it relinked
   (`updated_at > now() - interval '5 minutes'`) and check each one.

## Traps already paid for

- A token shared across recurrings (gateway or boilerplate word) mislinks by
  amount. Look at what each recurring learned before rebuilding patterns.
- Statement import: `commit` inserts `near_match` rows, so an SMS that rounds
  cents duplicates the bank row. Promote ≤1 COP / ≤1 day near-matches to match.
- A manual balance adjustment absorbs whatever error existed that day. Fixing
  that error later moves the balance — re-declare the real balance afterwards.
- A payment made well before its due date falls outside the grace window and
  will never auto-link; link it with an explicit `yearMonth`.
