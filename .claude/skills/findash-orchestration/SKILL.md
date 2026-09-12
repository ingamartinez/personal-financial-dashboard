---
name: findash-orchestration
description: How work reaches main in findash — the four roles and their trigger criteria, scripts/lane.sh for the per-issue worktree and its database, why the isolated unit is the orchestrator process rather than the lane, a pinned model per role, deny-first permissions, why the reviewer must differ from the implementer, prompt design (objective not route), and the herdr gotchas for the pane route. Load ONLY when orchestrating delegated lanes. A worker agent executing a task does not need this.
---

# Findash agent orchestration

**The orchestrator does not write code.** It delegates, then reviews what came
back. Work reaches `main` through opencode lanes, one role per lane, spawned
in-process since #944. Claude Code is the orchestrator and nothing else — it is the most
expensive model per token in the system, so it spends its budget on judgement,
not on volume.

There used to be a second route (Claude Code sub-agents in `.claude/agents/`).
It is gone as of #922: the two sets of definitions had drifted to 590 lines
versus 274 with no body matching its twin, only the opencode half was in git, and
a sub-agent runs on the same subscription as the orchestrator — which is the
budget this architecture exists to protect.

## The four roles

| Agent | Role | When to invoke |
| --- | --- | --- |
| `findash-explorer` | Read-only digest | BEFORE implementer when the task touches 4+ files, needs a module map, needs prior art from engram, or the issue scope is unclear. Skip for obvious tasks. |
| `findash-implementer` | Code + tests + lint/typecheck + commit | For EVERY code change. Turns a claimed issue into a branch ready to ship. Does NOT push, does NOT open PRs. |
| `findash-reviewer` | Read-only review (CRITICAL / WARNING / SUGGESTION) | BETWEEN implementer and ship.sh for non-trivial changes: db schema, queries, server actions, money logic, tenant-scoped data. Skip for docs-only, test-only, or mechanical refactors. |
| `scripts/ship.sh` | Push + PR + CI watch | AFTER implementer (and reviewer if applicable). A deterministic bash script, not a model — a model cannot wait for CI, and waiting is the whole job. |

```
gh issue (claim) → findash-explorer      (if 4+ files or scope unclear)
                 → findash-implementer   (ALWAYS — do not write code directly)
                 → findash-reviewer      (non-trivial: db, money, tenant, server actions)
                 → scripts/ship.sh       (push + PR + CI; --merge squash-merges when the gate holds)
```

Why: **the orchestrator does not know the 50+ gotchas** documented in engram for
this repo. The lanes do — they `mem_search` first thing and load the matching
skill. Bypassing them re-introduces bugs already paid for.

## Model routing (task 8 of #922)

Definitions pin `model:` in their own frontmatter. Do not leave it unset and do
not rely on the operator's profile — the profile is what silently reintroduced
the blindness this table exists to prevent.

| Role | Model | Lineage | ~$/task |
| --- | --- | --- | ---: |
| Orchestrator | Claude Code, Sonnet | Anthropic | subscription |
| `findash-explorer` | `llmgateway/gpt-5.6-luna` | OpenAI | **$0.02** |
| `findash-implementer` | `llmgateway/gpt-5.6-luna` | OpenAI | **$0.03** |
| `findash-reviewer` | `llmgateway/deepseek-v4.1-flash` | DeepSeek | **$0.01** |
| Overflow | `deepseek/deepseek-v4-flash` | DeepSeek | ~$0.20 |

**The rule is not "the reviewer uses model X". It is "the reviewer must differ
from the implementer's lineage."** A reviewer sharing the implementer's model
shares its blind spots and confirms what it already judged correct once. Assert
this at launch: if you override either model with `-m`, check the pair.

**Do not decide the review flag by hand.** #922 shipped that rule as prose —
"raise the reviewer for diffs touching money, schema, or a tenant boundary" —
and nothing executed it. On #511 the orchestrator nearly skipped it: the cheap
reviewer returned APPROVE on a diff that reopened incident #498, and the
CRITICAL surfaced only because a second reviewer was run on a hunch.

```bash
scripts/review-tier.sh            # the model, plus the reasons if any
scripts/review-tier.sh --models   # the reviewer model id, for scripting
```

It fails **closed** in the sense that matters: a broken base ref or a failed
diff prints an error and stops rather than silently answering "nothing to
review."

**One reviewer, `deepseek-v4.1-flash`, for every diff — high-risk or not.**
There used to be a second high-tier reviewer for risky diffs. Both attempts at
one got cut on the same evidence: measured on the #511 diff, same prompt
(#930):

| Reviewer | $/M in | $/M out | Findings |
| --- | ---: | ---: | --- |
| `deepseek-v4-pro` | 0.66 | 1.98 | 0 CRITICAL, 0 WARNING |
| `muse-spark-1.3` | 1.25 | 4.25 | 0 CRITICAL, 0 WARNING |
| **`deepseek-v4.1-flash`** | **0.15** | **0.60** | 0 CRITICAL, **3 WARNING** |

The cheapest reviewer found more than both of the ones it used to be paired
with — two of the three WARNINGs real, including a restore path not pairing
`connection_id` with `user_id`, which only `claude-opus-5` had caught before.
`muse-spark-1.3` stayed on as a second high-tier reviewer through #930/#933
anyway, on the theory that two reviewers of different lineage catch more than
one; #935 dropped it once nobody could point to a diff where it actually had.

**Everything in the routing is non-premium, deliberately.** DevPass meters
premium models ($5+/M in or $15+/M out) against a separate ~$10.44/week cap.
Non-premium spends only against the $87/month.

**`gpt-6-astra` is gone, and it cost something.** It was the ONLY reviewer that
caught the CRITICALs on #511, twice, where every cheaper model said APPROVE. It
is also $10/M in and $50/M out. Losing it means the orchestrator reads migration
diffs itself — that runs on a subscription, not against DevPass, which is where
the judgement should sit anyway. `scripts/review-tier.sh` still flags migration
and schema diffs in its reasons for exactly this: it is telling a human to read
carefully, not selecting a second model.

**n=1.** One diff, one run, stochastic sampling. Re-measure opportunistically on
the next high-risk diff rather than treating this table as settled — if a
future measurement shows a real gap the single reviewer misses, that is a new
proposal backed by data, not a reason to keep a second model warm on spec.

## Agent definitions come from the WORKTREE, not from main

A lane reads `.opencode/agents/*.md` out of its own checkout. Change the routing
on `main` and every lane whose branch predates that change keeps the old models,
silently — `herdr agent start ... --agent findash-reviewer` with no `-m` gets
whatever that worktree happens to pin.

This has already bitten once: a reviewer launched to run `deepseek-v4-pro` ran
`muse-spark-1.3` for a whole review because the lane branched before the
routing landed — back when the routing had two models to drift between.
Nothing errors; the pane just quietly says a different model name. The same
drift still applies to a single model: a stale worktree can pin a model this
repo no longer uses at all.

**So pass the model explicitly.** That is what `--models` is for:

```bash
model="$(scripts/review-tier.sh --models)"
herdr agent start <lane> --kind opencode --pane <id> -- \
  --auto --agent findash-reviewer -m "$model"
```

In-process there is no pane to read `Findash-Reviewer auto · <Model Name>` out
of, so ask for `MODEL_IN_USE=<id>` at the end of the report. Both definitions
already instruct it to.

## Launch role-specialized

Lanes launch already wearing a role. The prompt then carries only the objective,
per § Prompt design. Do not smuggle the role into the prompt — that is the "map"
that section measures as producing a worse result.

The default route is in-process `task`. `mode: all` keeps direct launch working,
so the same role still starts in a herdr pane when you want to watch it run:

```bash
herdr agent start <lane> --kind opencode --pane <pane_id> -- --agent findash-implementer
```

Definitions live in `.opencode/agents/findash-{explorer,implementer,reviewer}.md`
and are committed. `.opencode/` is deliberately not gitignored. `.claude/` is
ignored **except `.claude/skills/`**, which every lane needs — opencode reads
`.claude/skills/*/SKILL.md` natively, so one directory serves both runtimes.

## `--auto` plus deny-first

`opencode --auto` auto-approves anything **not explicitly denied**. Alone that
is wrong: an unbounded lane could merge without asking. Each `findash-*`
definition therefore carries a deny-first permission block so the role is
safe unattended. `--auto` is then per-role: a reviewer in auto still cannot
edit, because its own definition forbids it.

Do not run a lane with `--auto` unless its definition already denies the
surfaces that role must not touch. Herdr forwards native args after `--`, so
`-- --auto --agent findash-reviewer`. In-process there is no `--auto` flag: the
same deny-first block is what bounds a spawned lane.

What each role allows and denies (last matching bash rule wins — verified on
opencode 1.18.30 by launching a lane and watching a denied command come back
with *"The user has specified a rule which prevents you from using this specific
tool call"*, under `--auto`):

| Role | `bash` default | Shape |
| --- | --- | --- |
| explorer, reviewer | **`"*": deny`** | Allow-list of read-only commands: `rg`/`fd`/`bat`/`eza`/`jq`, `codegraph`, read-only `git`, read-only `gh`, plus the inert primitives, then the redirection denies. `edit: deny` also blocks `write` and `apply_patch` — there is no separate `write` permission key. |
| orchestrator | `"*": allow` since #966 | Denies push/rebase/`reset --hard`, `gh pr create`/`merge`/`api`, `gh auth switch`/`setup-git`, unprefixed `gh`, the relocation flags, `--no-verify`, `dropdb`, `psql -d findash`, redirection and `tee`. `ssh` is deliberately allowed (#946). `edit: deny` stays. |
| implementer | `"*": allow` | Same deny surface plus history surgery (`merge`, checkout/switch to `main`) and `ssh`, `pm2`, `rm -rf`. No redirection deny — it holds `edit: allow`. |

There is no shipper lane. `scripts/ship.sh` does that job — see § Shipping.

The two read-only roles get a deny-default because their command set genuinely
is small and enumerable, and they are the roles whose read-only guarantee is
worth something. The two roles that *act* do not: an allow-list there breaks the
lane on the first legitimate command nobody anticipated, and a blocked lane
under `--auto` is a pane that looks alive and is not. Bound those by denying
what is out of remit instead.

`read` is a separate key from `edit`, so `edit: deny` leaves reading intact.
Definitions do not set `external_directory` and do not hardcode operator
paths. Once the files are in the worktree, a lane should never leave it.

### How a bash rule actually matches (#957, #966 — measure, do not assume)

Four facts about opencode 1.18.30, read out of the shipped binary and then
confirmed by running real lanes. All four are easy to get backwards, and a rule
built on the wrong one reads exactly like a rule that works.

1. **Order is file order, and the last match wins.** Rules are the YAML keys in
   the order written, appended after the global config's rules; the evaluator
   takes the *last* entry that matches. A deny placed after an allow beats it and
   a deny placed before it does not. `opencode debug agent <name>` prints the
   resolved list in evaluation order — read it rather than the file.
2. **`*` is `.*` under a dotall regex — it crosses `/`, spaces and newlines.**
   There is no way to say "one path segment". A pattern with a wildcard in the
   middle therefore matches far more than it looks like it does. A trailing
   `" *"` is the one special case: it compiles to `( .*)?`, so the bare command
   matches too. The whole pattern is **anchored** —
   `new RegExp("^" + pattern + "$", "s")` — so a rule with no trailing wildcard
   matches that command and nothing longer: `"git branch": allow` refuses
   `git branch --show-current`, verified on a real explorer lane.
3. **Each command in the line is matched separately, and any deny denies the
   call.** opencode parses the command with tree-sitter and tests every `command`
   node — both sides of `&&`, the inside of `$(...)` — against the ruleset;
   `cd`-family nodes are skipped. So `cd /x && git push` is still a `git push`.
   The pattern tested is the node's raw source text, env-assignment prefix
   included. That cuts both ways: a `gh` **allow** rule must carry
   `GH_CONFIG_DIR=*` to be the identity guard, and on an allow-default role the
   guard has to be spelled out as a `"gh *": deny` instead.
4. **A redirection IS part of that text — for the node it binds to.** The
   evaluator walks `descendantsOfType("command")` but takes the *parent's*
   source when the parent is a `redirected_statement`, so `bat AGENTS.md > f` is
   tested as the whole string, `>` included, and `"*>*"` matches it. Two
   non-obvious corollaries, both measured: in `bat f | sort > out` the redirect
   binds to `sort`, so the tested text is `sort > out` and it is caught; but a
   pipeline segment with no redirect is tested alone, as `tee out` with **no
   leading space** — which is why the rule has to be `"tee *"` and not
   `"* tee *"`.

Consequence, and the reason `gh api` has no allow-list carve-out: an endpoint
allow-list cannot be written safely. Measured on this repo, with rules
`"GH_CONFIG_DIR=* gh api *": deny` followed by
`"GH_CONFIG_DIR=* gh api repos/*/pulls/*/reviews*": allow`, the plain
`gh api .../pulls/958/merge --method PUT` came back denied — and the same call
with `-f decoy=/pulls/1/reviews` appended ran, and GitHub answered
`{"merged":true}`. Fact 2 is why: the middle `*` swallows the flags. `gh api` is
denied outright in all four definitions, and the one read that used it now goes
through `gh pr view --json reviews`, which is a read-only subcommand rather than
a glob that hopes to be one.

### `edit: deny` does not make a role read-only (#966)

`edit: deny` gates the `edit`/`write`/`apply_patch` tools. `bash` is a separate
surface, and nothing in an allow-list of reads looks at redirection. Measured on
the unpatched explorer:

```
opencode run --agent findash-explorer --auto \
  'bat --style=plain AGENTS.md > /tmp/probe.txt'   →  "RAN."  →  4762-byte file
```

The same allow-lists were missing every shell primitive, and by fact 3 a trailing
`echo` sinks the whole call: `scripts/lane.sh check; echo "---exit:$?"` came back
refused in a live #921 session and the human was told the lane check had failed,
when `scripts/lane.sh check` alone exits 0.

#966 fixed both — but not with the same shape in every role, because the second
half of that bug is an argument against allow-lists, not for them.

**explorer and reviewer keep `"*": deny`.** Their command set genuinely is small
and enumerable, and they are the two roles whose read-only guarantee is worth
enforcing. Their bash block now ends with exactly these six lines, in this order
(the denies must come last — fact 1):

```yaml
    "echo *": allow
    "printf *": allow
    "true": allow
    "pwd": allow
    "*>*": deny
    "tee *": deny
```

Every row below is one real `opencode run --agent <role> --auto` on the shipped
rules, not a reading of the YAML:

| Case | Result | Proven on |
| --- | --- | --- |
| `echo "x"` | runs | explorer, reviewer |
| `git status --short; echo "---exit:$?"` | runs | explorer, reviewer |
| `bat package.json \| head -5; git status --short; echo ---` | runs | explorer |
| `git diff --stat`, `gh pr view --json state` | runs | explorer, reviewer |
| `bat AGENTS.md > f` | **refused**, no file on disk | explorer, reviewer |
| `echo probe > f` | **refused** | explorer, reviewer |
| `bat AGENTS.md >> f` | **refused** | explorer |
| `bat AGENTS.md \| tee f` | **refused** | explorer |
| `bat AGENTS.md \| sort > f` | **refused** | explorer |
| `{ bat AGENTS.md; } > f` | **refused** | explorer |
| `echo $(bat AGENTS.md > f)` | **refused** | explorer |

`"*>>*"` appears in #966's proposal and is deliberately **not** shipped: `*` is
`.*` under a dotall regex (fact 2), so `"*>*"` already matches `>>` — measured
on a real lane, not assumed. Likewise the rule is `"tee *"`, not `"* tee *"`:
by fact 4 a pipeline segment is tested alone, as `tee out`, with no leading
space.

**The false-positive cost — you will hit this, and the refusal will not say
why.** `"*>*"` is `.*>.*` over the node's raw source. It cannot tell a
redirection operator from a `>` character. Both of these came back refused on a
real run:

- `git log --oneline -3 2>/dev/null` — any `2>`, `2>&1` or `&>` reads as a
  redirection. Drop it; the bash tool already returns stderr.
- `echo "a > b"` — a literal `>` inside a quoted argument, i.e. `rg "a>b" f`,
  `jq '.n > 1'`, `git log --grep "a > b"`.

No glob separates the two, which is why #966 rejected the narrower shapes. A
deny-first role that needs a literal `>` should say so and stop, per its own
§ Scope bounding — not rephrase its way around the rule.

### The orchestrator moved to allow-default (#966)

`findash-orchestrator` was an allow-list too, and in one live session that
allow-list refused three legitimate commands: `echo` (above), `ssh` — which
blocked a production diagnostic and is what #946 is about — and it was on course
for a fourth. The rationale that has always governed findash-implementer applies
verbatim: an allow-list breaks the lane on the first legitimate command nobody
anticipated, and a blocked lane under `--auto` is a pane that looks alive and is
not.

The shape was also inverted. The role that writes code had the wider bash
surface than the role that cannot write at all.

So `bash` is now `"*": allow` **with no denies at all** — the repo owner's
explicit call, after weighing what it gives up. `edit: deny` and the `task`
allow-list are the only two boundaries left on that seat.

A deny-list was written first and briefly shipped (`git push`, `gh pr merge`,
`gh api`, `dropdb`, the relocation flags, unprefixed `gh`). It was removed on
the owner's instruction. The findings that produced it are kept below because
they still apply to `findash-explorer` and `findash-reviewer`, which remain
deny-first, and because anyone re-adding a deny anywhere needs them.

**What the orchestrator seat now relies on.** Shipping through `scripts/ship.sh`
rather than `gh pr merge`, prefixing every `gh` call, not writing code, not
touching the `findash` dev database — all of it is now convention held by the
agent, not enforcement held by the engine. Its definition states each one
explicitly, because a rule nothing enforces has to at least be written down
where the agent reading it will see it.

The identity one is the sharpest and is not a safety rail: with no `"gh *"`
deny, an unprefixed `gh` call authenticates as a different account and posts
publicly under the wrong name. Nothing errors.

**These facts still matter wherever a deny exists.** Every deny must be written
wrapped (`"*...*"`): by fact 2 a pattern compiles anchored,
`new RegExp("^" + pattern + "$", "s")`, so `"git push*"` never matched
`GIT_DIR=.git git push` — the env-assignment prefix is part of the node text
(fact 3).

Wrapping is **not** enough on its own, and this is the trap: a wrapped
`"*git push*"` still does not match `git -C /tmp/x push`, because that string
contains no substring `git push`. No glob can put a wildcard between `git` and
`push` without also matching `bat .github/workflows/push.yml`. Flags that
relocate the target (`git -C`, `--git-dir`, `--work-tree`, `gh -R`, `gh --repo`)
have to be denied outright, as their own rules.

And a redirection deny is only a write boundary on a deny-default role. On an
allow-default one it stops nothing — `cp`, `sd`, `sed -i`, `python3 -c` all
write and are permitted — while still refusing `2>/dev/null`. Explorer and
reviewer keep `"*>*"` for exactly that reason: their allow-lists contain
nothing else that can write.

## Review gate is not automatic

A lane told to go "end to end" will skip the reviewer unless the
orchestrator inserts it. For non-trivial changes (db schema/queries, server
actions, money logic, tenant-scoped data) the orchestrator MUST insert a
reviewer stage before merge, and the implementing lane MUST stop at PR-open
rather than auto-merge. Mechanical refactors, docs-only, and test-only changes
keep skipping the reviewer.

## Epic-phase PRs do not close the epic

A PR delivering one phase of a multi-phase epic uses `Part of #N`, never
`Closes #N` — otherwise the epic dies with remaining phases unwritten. That
PR also fails auto-merge condition (b) ("PR closes a single issue"), so it
stops at PR-open and waits for a human.

## One lane, end to end

Since #944 the lanes are spawned **in-process**, and an in-process subagent
inherits the parent's cwd — opencode 1.18.30 has no `directory:`/`cwd:`
frontmatter key, and the definitions deliberately do not set
`external_directory`.

So **the isolated unit is the orchestrator process, not the lane.** Lanes within
one issue run sequentially on one branch: they *should* share a tree. What
collides is two issues at once. One orchestrator per issue, launched with its cwd
inside that issue's worktree, and everything it spawns inherits the right tree.

`scripts/lane.sh` owns the four things a lane is — all four or none:

```bash
scripts/lane.sh create --issue 949        # slug and phase read off the issue
```

Plain `git worktree`; #944 took herdr off this path. Worktree and branch off
`origin/main`, a copy of the gitignored `.env.local` (the lane fails at runtime
without it), `bun install` (`node_modules` is not shared), and
`findash_test_<issue>` **with the UTC `ALTER`** — not optional, skill
`findash-testing` — migrated and seeded. Any failure rolls the whole lane back.

Then start the orchestrator **inside** the path it prints, with that
`FINDASH_TEST_DB` exported. A running process cannot move itself into a
worktree, so this is the one step that happens outside the agent.

```bash
scripts/lane.sh start --issue 953         # create-or-reuse, launch, tear down
```

`start` (#953) is the human's one command per issue: it creates the lane or
**reuses** an existing one — resuming is the same command, not a second verb —
opens `opencode "$dir" --agent findash-orchestrator --auto`, and when that exits
reads the PR state for the lane branch. `MERGED` removes the lane; anything else
leaves it exactly as it is and prints where it is parked.

It launches the **interactive TUI and passes no `--prompt`**. The opening
exchange is deliberate: the human hands over the issue and they verify the scope
before anything is spent, which is where a badly scoped issue gets caught.
`--dry-run` prints the exact launch line and the teardown decision without
running either — use it instead of spending a live orchestration to check a
change to the script.

`start` runs the teardown from the **primary checkout**, not from the lane:
`remove` refuses to delete the worktree you are standing in (#949), so a `start`
that launched from inside the lane would trip its own guard. It stays in the
primary checkout for the whole run and hands opencode the lane path positionally.

```bash
scripts/lane.sh start                     # talk mode: no lane, no teardown
```

`start` with **no `--issue`** (#956) is the same verb for the other half of the
flow: work that arrives as an idea rather than an issue number. It launches the
orchestrator in the **primary checkout** and creates nothing — no worktree, no
branch, no database — so there is nothing to tear down and the post-exit
teardown is not reached at all. `--dry-run`, `-m` and `--no-auto` work in both
modes; `--slug`, `--phase`, `--agent` and `--base` shape a lane and are refused
when there is none.

Standing in the primary is safe precisely because `check` already refuses an
implementer there: **talking in the primary breaks nothing, implementing does.**
One verb covers both modes and degrades into the safe one on its own.

A talk session does **not** carry into a lane afterwards, and is not meant to —
`opencode debug scrap` keys projects by worktree path, so sessions do not port
across worktrees. The issue is the handoff: written, reviewable, and source of
truth #1. The chat is the draft. That is why #956 also widened the
orchestrator's allow-list to `gh issue create`, `edit`, `close` and `delete`
(every rule prefixed `GH_CONFIG_DIR=*`, which is what keeps it authenticating as
the right account) — a talk session that cannot write its own issue dead-ends at
the exact step `AGENTS.md` § Issue-first makes mandatory. `delete` is the one
with no undo and was granted on the owner's call, not by oversight.

```bash
scripts/lane.sh check                     # before the first implementer, every time
```

Non-zero in the primary checkout, on `main`, or in a worktree missing
`.env.local` or `node_modules`. `findash-orchestrator` runs it before delegating
an implementer and stops if it fails: #944 shipped the isolation rule as prose
and the primary checkout went on hosting lane branches anyway.

```bash
scripts/lane.sh remove --issue 949        # worktree, branch, database, directory
```

It refuses while you are standing inside the lane, and refuses to `branch -D`
commits not on `origin/main` unless GitHub says the PR merged — a squash rewrites
them, so the graph alone always looks unmerged — or you pass `--force`. It also
drops the `_wN` worker clones a killed suite leaves behind.

> **The step that used to get forgotten is now automatic.** A lane that touched
> `drizzle/` gets the **shared** `findash_test` re-migrated on removal — its own
> database had the migration and you just dropped it. Left undone, the next full
> suite fails on tests that are green in CI, which looks like a regression on
> `main` and is not one: check `drizzle.__drizzle_migrations` against
> `drizzle/meta/_journal.json` before debugging any code.


## Shipping

There is no shipper agent. `scripts/ship.sh` runs pre-flight, the gates, the
push, the PR and the CI watch — every step has exactly one correct answer, and
the step that dominates wall-clock is waiting for CI. A model cannot wait, which
is why the agent needed the "poll `gh pr checks` inline, never `ScheduleWakeup`"
workaround. `gh pr checks --watch` does it natively.

```bash
scripts/ship.sh                       # infer issue and link word from the commits
scripts/ship.sh --part-of             # epic-phase PR
scripts/ship.sh --no-test             # a parallel lane already ran the suite
scripts/ship.sh --dry-run             # gates only, push nothing
scripts/ship.sh --merge               # squash-merge if the gate holds, then land on main
```

It refuses to ship from `main`, refuses a dirty tree, refuses a non-conventional
commit subject, and merges **only** under `--merge` and only when the
`AGENTS.md` auto-merge conditions hold: CI green, `Closes` (not `Part of`), and
`mergeable == MERGEABLE`. Any of those missing and it refuses — a human decides.
Without `--merge` it reports the verdict and stops, as before. Multiple issue
numbers across the commits automatically demote `Closes` to `Part of`, which
also disqualifies the merge.

The gate lives in the script, not in an agent's permission list, because a
permission rule cannot read CI status — it can only allow `gh pr merge` and
trust the model to have checked. That is the difference between a gate and a
promise. Same reason the post-merge `git checkout main` runs here: the
orchestrator needs a fresh base for the next lane, not a checkout permission.

Run it from the lane's worktree with that lane's `FINDASH_TEST_DB` exported, or
with `--no-test` if the implementer already ran the affected specs and no other
lane is idle.

**`ship.sh` also owns the "a human is needed" report (#953).** `lane.sh start`
opens an interactive session and only regains control when the human quits,
which can be hours after the run ended — so the post-exit hook is the wrong
place to notice trouble. `ship.sh` is the code that learns CI went red, that no
checks ever registered, or that the merge was refused, at the moment it learns
it. On each of those it comments on the issue (source of truth #1, durable, it
notifies on its own, identical on the Mac and on ia-server) and fires a
best-effort desktop notification — `osascript` on darwin, `notify-send` on
Linux, a silent no-op anywhere else. The notifier can be missing or broken
without failing the run or swallowing the comment. A green merge reports
nothing: **silence is the success report.** `--no-report` suppresses both, for
a human iterating on a red branch who does not want the issue spammed.

## Prompt design: give the objective, not the route

Do **not** hand a delegated agent the repo's conventions. Measured on this repo:
an agent asked only _"what are this repo's conventions?"_, with no pointers,
independently read `AGENTS.md`, `CLAUDE.md` and `docs/`, **queried
engram on its own**, and surfaced tenant safety, the money convention and the
gotchas. The same agent
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

## Operating parallel lanes

Parallel means parallel **issues**: one orchestrator process per issue in its own
`scripts/lane.sh` worktree. Lanes inside an issue are sequential and in-process —
`task` blocks until the lane returns, so no pane, no watcher, no scrollback.
Everything from **A killed watcher** down is the herdr pane route, which still
works when you want to watch a lane run.

- **Cap at ~3 concurrent issues on a dev Mac.** Lanes are RAM-bound, not
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
- **A prompt sent too early is silently dropped.** `herdr agent prompt` issued
  right after `herdr agent start` can vanish while the opencode TUI is still
  painting its splash. The call returns success, the agent stays `idle`, and the
  input line is empty — a lane that looks alive and never received its task.
  `agent start` returning `interactive_ready: true` is not enough. Confirm the
  turn actually began before registering a watcher: `terminal_title` flips to
  `OC | <objective>` once it does, and `agent read` shows the prompt in the
  transcript. Verified on herdr 0.9.0 / opencode 1.18.30.
- **Do not judge an agent from its scrollback.** A pane read mid-run surfaces
  hypotheses the agent later refutes itself. One review showed a `CRITICAL` in
  scrollback and ended `APPROVE` with zero findings. The agent runs on the
  terminal's alternate screen, so rows that scroll away never reach herdr's host
  scrollback and no `--lines` value brings them back. Ask for the final report —
  but **how depends on the role**:
  - `findash-implementer` can write it to a file (`/tmp/<lane>-digest.md`);
    read the file.
  - `findash-explorer` and `findash-reviewer` **cannot**. Both set `edit: deny`,
    which also blocks `write` and `apply_patch`. Asking one for a file leaves it
    at a permission dialog with `agent_status: blocked`, holding a finished
    report it cannot deliver. Do not relax the denial — a read-only role that
    can write files is not read-only. Both definitions therefore cap their own
    output (350 words for the explorer digest, 400 for the review) and deliver
    it in the pane. Short output never hits the scrollback problem. If one is
    already blocked, `herdr agent send-keys <name> esc`, then re-prompt.
- **A tab is not ready the moment `tab create` returns.** `herdr agent start`
  needs the target pane's shell at its interactive prompt. Called immediately
  after `herdr tab create` it fails with `agent_not_found` — even though the
  pane exists and `herdr pane list` reports it. The error names the agent, not
  the pane, so it reads like a bad `--pane`, and the identical command succeeds
  on retry seconds later. Wait for the shell before starting the agent.
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

  Four gotchas:
  - **`pane_id` is required per subscription.** No wildcard. Omitting it fails
    with `invalid_request: missing field 'pane_id'`. One entry per pane.
  - **`agent_status` is a server-side filter — and `blocked`+`done` is not
    enough.** Subscribe to `idle` as well. A finished lane reports `idle` or
    `done` depending on whether the server already considers that completion
    seen, and both are delivered when you subscribe to them: verified on
    herdr 0.9.0 with two lanes finishing minutes apart, one arriving as
    `idle` and the other as `done`. A `blocked`+`done`-only filter goes
    permanently deaf to the `idle` half. Leave `working` out — that one is
    pure noise.
  - **A pushed event is NOT shaped like the request.** The subscription filter
    uses `type` + `pane_id`, but the event the server pushes uses different
    keys entirely:

    ```json
    {
      "event": "pane.agent_status_changed",
      "data": {
        "agent_status": "idle",
        "pane_id": "w1:p34",
        "agent": "opencode",
        "workspace_id": "w1"
      }
    }
    ```

    It is `event` / `data`, not `type` / `params`. A reader that looks for
    `type` (the name it just subscribed with) silently matches nothing and the
    watcher stays deaf while looking healthy. Do not trust the underscore
    names in `herdr api schema --json` either — that `EventKind` enum is the
    internal serialization (`pane_agent_status_changed`); the wire protocol
    uses dots, and subscribing with the underscore form is rejected with
    `invalid_request: unknown variant`.

  - **Hold the connection with a sleep loop, not `cat`.** Under a runner with
    no stdin, `cat` takes EOF immediately and the subscription dies one line
    after `subscription_started`.

  `herdr api schema --json` dumps the request/response/event schema.

- **When you poll GitHub, read the right collection.** A reviewer told to
  "post your review as a comment" posted a **pull request review**.
  `gh pr view <n> --json comments` returned `[]` while the verdict sat on the
  PR. The lane looked silent when it was finished.

  ```bash
  GH_CONFIG_DIR=~/.config/gh-findash gh pr view <n> --json reviews \
    --jq '.reviews[]|{state,user:.author.login,body}'
  ```

  Not `gh api .../pulls/<n>/reviews` — that is denied since #957, and this
  returns identical output.

  A review posted without an explicit approve or request-changes shows
  `state: "COMMENTED"`. Symptom: pane says "posted", herdr says `done`,
  comments array empty — check the reviews endpoint before re-prompting.

Other agents (Codex, etc.) driving this repo directly can ignore the lane
mechanics above — the rules in `AGENTS.md` (issue-first, branch naming, commits,
PRs, gh identity, testing) still apply to all agents equally.
