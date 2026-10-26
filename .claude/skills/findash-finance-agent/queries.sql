-- Read-only queries for the findash finance agent. Run with
--   sudo -u findash psql -d findash -v uid=<user_id> -f queries.sql
-- or paste one block. Every block filters by :uid.
set default_transaction_read_only = on;

-- Recurrings and whether this month is paid (set :ym, e.g. '2026-10').
select r.id, r.label, r.day_of_month, r.amount_cents / 100 as amount, r.currency,
       (select string_agg(t.id || ' ' || to_char(t.occurred_at, 'MM-DD'), ', ')
          from transactions t
         where t.user_id = r.user_id and t.recurring_id = r.id
           and t.recurring_year_month = :'ym' and t.deleted_at is null) as paid_by
from recurring_transactions r
where r.user_id = :uid and r.active and r.deleted_at is null
order by r.day_of_month;

-- Linked history of one recurring (set :rec).
select t.recurring_year_month, t.id, t.occurred_at::date, t.amount_cents / 100, t.description_raw
from transactions t
where t.user_id = :uid and t.recurring_id = :rec and t.deleted_at is null
order by t.occurred_at;

-- What each recurring learned as fingerprint — check before any rebuild.
select r.id, r.label, string_agg(p.pattern || '(' || p.observation_count || ')', ', ')
from recurring_transactions r
left join recurring_description_patterns p on p.recurring_id = r.id and p.user_id = r.user_id
where r.user_id = :uid and r.deleted_at is null
group by r.id, r.label order by r.id;

-- Repeated unlinked expenses: candidates for a missing recurring.
select upper(left(coalesce(canonical_merchant, enriched_merchant, merchant, description_raw), 22)) as m,
       currency, count(distinct date_trunc('month', occurred_at)) as months, count(*) as n,
       round(avg(amount_cents) / 100) as avg_amount
from transactions
where user_id = :uid and deleted_at is null and recurring_id is null and amount_cents < 0
  and transfer_group_id is null and not coalesce(is_adjustment, false)
  and occurred_at >= now() - interval '6 months'
group by 1, 2 having count(distinct date_trunc('month', occurred_at)) >= 3
order by months desc, avg_amount;

-- Balance adjustments on one account (set :acc) — each one hides an error.
select id, occurred_at::date, amount_cents / 100, raw_data ->> 'reason'
from transactions
where user_id = :uid and account_id = :acc and deleted_at is null and is_adjustment
order by occurred_at;

-- Txs relinked in the last few minutes — run right after a retokenize.
select t.id, r.label, t.recurring_year_month, t.occurred_at::date, t.amount_cents / 100, t.description_raw
from transactions t join recurring_transactions r on r.id = t.recurring_id and r.user_id = t.user_id
where t.user_id = :uid and t.updated_at > now() - interval '5 minutes'
order by r.label, t.occurred_at;
