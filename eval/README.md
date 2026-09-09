# Classification eval harness

Measures how well a model classifies this app's transactions, against the
owner's own manually-classified rows as ground truth.

It exists because "the prompt is better now" is not a claim anyone should
accept without a number. It produced the measurement that closed #816 §1 —
the conditional-specificity prompt fix moved the convention-bound tier from
**0.7% to 82.7%** exact accuracy — for about $0.20 of API spend.

## The data is NOT in this repo, and must not be

This repository is public. The harness runs on real production transactions:
descriptions that carry partial account numbers, exact amounts, months of
personal financial history. Those files are gitignored and stay that way.

What is committed is the **code**. You regenerate the inputs from your own
database before the first run.

## First run

```bash
# 1. Ground truth — your manually-classified transactions.
psql -d findash -tAc "
SELECT json_agg(row_to_json(t))::text FROM (
  SELECT id, description_raw, description_clean, merchant, canonical_merchant,
         amount_cents::text, currency, channel, category_slug
  FROM transactions
  WHERE user_id = 1 AND deleted_at IS NULL
    AND classification_method IN ('manual','manual_confirmed')
    AND category_slug IS NOT NULL
  ORDER BY id
) t" > eval/txs.json

# 2. Rule-engine-classified rows, same shape — used as a second tier.
#    Same query with classification_method = 'rule'.

# 3. Build the scored dataset (tiers, splits) from those two.
node eval/build-dataset.mjs
node eval/split.mjs
```

`categories.json` is committed — it is the seeded taxonomy, already public in
`src/lib/db/seed-reference-data.ts`.

## Running

```bash
export ANTHROPIC_API_KEY=...          # and the other providers' keys, if used

node eval/run.mjs                      # every model in models.mjs
node eval/run.mjs sonnet-5             # substring filter — one model
node eval/score.mjs                    # the comparison table
node eval/decid.mjs                    # decidable-rows view
```

Roughly $0.20 for one Anthropic model over ~217 rows. The full multi-provider
sweep that produced the original report cost $1.51.

## Two things that will bite you

**`run.mjs` skips a model when `results/<key>.json` already exists** and prints
`already done, skipping`. To re-measure, move the old file aside — and keep it.
An old-vs-new comparison scored by the same scorer is worth far more than
comparing against numbers quoted in an issue, which may use a different metric
definition. That is how the #816 measurement was done: the old result was
preserved, both were scored, and the delta was read off one table.

**`prompt.mjs` slices `buildSystemPrompt` out of `src/lib/classification/ai.ts`
and evaluates it.** Nothing is retyped. This is deliberate: the harness always
measures the prompt production actually sends. Do not "clean this up" into a
local copy — a copy silently measures a stale prompt, and you would not find
out from a passing run. It strips a fixed set of TypeScript annotations and
throws if any remain, so adding a new annotated signature inside the sliced
block will fail loudly rather than silently.

## Reading the output

`score.mjs` prints per-model: `easy`, `hardDec`, `conv`, `exact`, `family`,
`null%`, schema-compliance, `$/1k`, p50/p95 latency, and ECE (calibration).

`conv` is the convention-bound tier — rows whose description genuinely cannot
distinguish a parent category from its children (`Transferencia QR a cuenta
*0000` says nothing about who received the money). That tier is where prompt
wording shows up most sharply, and it is the one to watch when changing
category-selection instructions.

Watch for **overcorrection** in the error breakdown. Fixing "always pick the
child" can introduce "always pick the parent"; after #816 the residual
`transferencia-persona -> transferencias` class sits at 6 occurrences, against
99 for the original error it replaced. `hardDec` is the guard rail — it holds
the rows where the child category is verifiably correct, so it must not fall.

## Not linted

`eval/**` is in `globalIgnores` in `eslint.config.mjs`. This is an offline
research tool that runs under bare Node and prints comparison tables for a human
to read, so `no-console` does not apply — the same reasoning as
`public/widgets/scriptable/**`. It is **not** a "scripts are special" carveout:
everything inside `src/` and `scripts/` still logs through Pino.
