# Findash — Agent Workflow

The contract for any agent (Claude, opencode, Codex) or human working on this
repo. Multiple agents may run in parallel; the rules below prevent collisions.

**This file is deliberately short.** Everything else loads on demand from
`.claude/skills/` — opencode reads that directory natively, so one set of
definitions serves every runtime.

| Skill                   | Load it before                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `findash-tech-baseline` | writing or reviewing any code in `src/`, `scripts/`, `instrumentation.ts` |
| `findash-testing`       | running the suite, adding a test, creating a worktree lane                |
| `findash-github`        | any `gh` command beyond a read, pushing over HTTPS, labelling an issue    |
| `findash-review`        | reviewing a diff, or self-reviewing before opening a PR                   |
| `findash-orchestration` | delegating work to lanes. A worker executing a task does NOT need this.   |

## Source of truth

1. **GitHub Issues** — granular tasks, bugs, features. Each carries a `phase-N`
   label and one or more domain labels.
2. **GitHub Project board** ("Findash Roadmap") — `Backlog` → `Next Up` →
   `In Progress` → `Done`.
3. **engram** — 50+ documented gotchas, one per past bug. `mem_search` before
   you touch an unfamiliar module; it is cheaper than rediscovering the bug.
4. **`README.md` → `docs/`** — design rationale that outlives an issue:
   ingestion channels, AI strategy, roadmap phases, SLOs.
5. **This file** — workflow conventions only.

Architecture, DB schema, folder structure and UI pages are **not** documented in
prose on purpose: they are derivable from code and a markdown copy goes stale in
weeks. Use CodeGraph (`codegraph explore "..."`) or read the source.

## Issue-first rule (mandatory)

**No code changes without an open issue.** Before any work:

1. Search: `GH_CONFIG_DIR=~/.config/gh-findash gh issue list --search "<keywords>"`.
2. If none exists, create one with a `phase-N` label and a domain label.
3. Claim it: `gh issue comment <N> --body "Picking this up — agent: <name>"`.
   This is the lock signal for other agents.
4. Move it to `In Progress` on the board.

## gh CLI identity (mandatory)

Every `gh` invocation in this repo MUST be prefixed with
`GH_CONFIG_DIR=~/.config/gh-findash`. Without it you silently authenticate as a
different account. **Never** run `gh auth switch` or `gh auth setup-git`
unprefixed — they rewrite the global gitconfig. Full rules, including the HTTPS
push token and the `workflow` scope: skill `findash-github`.

## Branch naming

```
<agent-name>/<phase>/<issue-number>-<short-slug>
```

Examples: `claude/phase-1/12-rule-engine`, `codex/phase-2/27-sms-parser`.

## Commit format

Conventional commits: `<type>(<scope>): <subject> (#<issue>)`.

Types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `perf`, `style`.

After running any scaffolder or codegen (`shadcn`, `bunx create-*`, drizzle
generators), run `git log -1` **before** committing manually — some tools
auto-create commits with non-conventional messages. If you find one,
`git reset --soft HEAD~1` and rebuild it properly. Never push those.

## PR convention

- Title: same as the closing commit.
- Body includes `Closes #<issue>` so the issue auto-closes on merge. A PR
  delivering one phase of a multi-phase epic uses `Part of #N` instead —
  otherwise the epic dies with phases unwritten.
- Self-review against skill `findash-review` before opening.
- Squash merge by default.
- **CI gate**: `.github/workflows/ci.yml` runs lint + format + typecheck + the
  full suite + `next build` on every PR. Red CI blocks merge.
- **Auto-merge authorization**: an agent may squash-merge its own PR without
  asking when ALL of: (a) CI green on the latest commit, (b) the PR closes a
  single issue, (c) no conflicts with `main`. Otherwise ask.

## Multi-agent etiquette

- One issue → one agent at a time. Claim by commenting.
- Found related work in progress? Comment on the OTHER agent's issue. Do not
  open a parallel branch.
- Never force-push to `main`. Never bypass hooks.
- Discovered a non-obvious gotcha? `mem_save` it, and if it is a rule rather
  than a war story, add it to the matching skill.

## Local commands

```bash
bun install
bun run dev              # http://localhost:3100
bun run lint
psql -d findash          # peer auth, no password
```

`.env.local` is NOT committed — see `.env.example`. Production runbook:
`docs/deploy.md`. Test database rules: skill `findash-testing` — a bare
`bun run test` in a worktree corrupts another lane's fixtures.
