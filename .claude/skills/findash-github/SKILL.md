---
name: findash-github
description: The full gh CLI identity rules for findash (GH_CONFIG_DIR=~/.config/gh-findash, inlining the token for HTTPS push, the workflow scope, commands that must never run unprefixed), plus the canonical issue label list. Load before any gh command beyond a plain read, before pushing over HTTPS, or before labelling an issue.
---

# Findash on GitHub


ia-server runs multiple agents under the same Linux user. The default `~/.config/gh/` belongs to `amartinezcb` (the cc agent). Every `gh` invocation in this repo MUST be prefixed with `GH_CONFIG_DIR=~/.config/gh-findash` — without it you silently authenticate as the wrong account.

```bash
# CORRECT — always prefix every gh call
GH_CONFIG_DIR=~/.config/gh-findash gh issue list
GH_CONFIG_DIR=~/.config/gh-findash gh pr create ...

# WRONG — uses global config = amartinezcb's account
gh issue list
```

**HTTPS push** — the global git credential helper points at the wrong account, so inline the token:

```bash
TOK=$(GH_CONFIG_DIR=~/.config/gh-findash gh auth token --user ingamartinez)
git push "https://ingamartinez:${TOK}@github.com/ingamartinez/personal-financial-dashboard.git" HEAD
```

**NEVER run without the prefix:**

```bash
# These rewrite the global gitconfig and break the cc agent — always prefix them
GH_CONFIG_DIR=~/.config/gh-findash gh auth switch ...
GH_CONFIG_DIR=~/.config/gh-findash gh auth setup-git ...
```

**`workflow` scope** — the token may lack this scope (required to push changes to `.github/workflows/`). Fix once interactively:

```bash
GH_CONFIG_DIR=~/.config/gh-findash gh auth refresh -h github.com -s workflow
```

**Verify identity** at any time:

```bash
GH_CONFIG_DIR=~/.config/gh-findash gh auth status
# Should show: Logged in to github.com account ingamartinez
```


## Labels (canonical list)

| Label                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase-1`, `phase-2`, `phase-3`, `phase-4` | Roadmap phase from PLAN.md                                                                                                                                                                                                                                                                                                                                                         |
| `infra`                                    | Setup, tooling, deployment                                                                                                                                                                                                                                                                                                                                                         |
| `db`                                       | Schema, migrations, seed                                                                                                                                                                                                                                                                                                                                                           |
| `ingestion`                                | Data ingestion (Apple Pay, SMS, OCR, CSV, recurring)                                                                                                                                                                                                                                                                                                                               |
| `classification`                           | Rule engine + AI classifier                                                                                                                                                                                                                                                                                                                                                        |
| `ui`                                       | Pages, components, layout                                                                                                                                                                                                                                                                                                                                                          |
| `ai`                                       | Claude API integration (Haiku, Sonnet, Vision)                                                                                                                                                                                                                                                                                                                                     |
| `bug`                                      | Something broken                                                                                                                                                                                                                                                                                                                                                                   |
| `documentation`                            | Documentation only                                                                                                                                                                                                                                                                                                                                                                 |
| `good-first-task`                          | Small, well-scoped, easy entry point                                                                                                                                                                                                                                                                                                                                               |
| `blocked`                                  | Cannot proceed until an external condition is met (missing data, pending decision, dependency on another issue). Orthogonal to `phase-N` and to the Project board `Status` column — use it as a flag, not a status. When applying, leave a comment on the issue explaining WHAT it's blocked on. Filter it out with `-label:blocked` when looking for work you can actually start. |

