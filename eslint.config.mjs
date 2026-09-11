import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // All log output flows through the centralized logger (src/lib/logger.ts).
  // No carveouts for scripts/seeds/CLI — Pino's pretty transport gives the
  // same UX, and keeping sanitization + levels in one place is what makes
  // this rule useful. See AGENTS.md and issue #279 for rationale.
  {
    rules: {
      "no-console": "error",
      // Align with the TypeScript convention: identifiers prefixed with "_" are
      // intentionally unused (e.g. interface-satisfying params in stub parsers).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // Documented gotchas, promoted from engram to a deterministic rule (#922).
  //
  // Every rule below encodes a bug this repo already paid for. A rule that
  // blocks at pre-commit is free and cannot be forgotten; a rule that lives
  // only in an agent prompt and an unversioned local SQLite is neither.
  //
  // Four documented gotchas are deliberately NOT here, because no AST
  // predicate expresses them and a rule that guesses is worse than no rule:
  //   - "FK to a non-PK column needs inline .unique(), not uniqueIndex()" —
  //     ESLint cannot know which column is an FK target.
  //   - "money is bigint amount_cents, never a float" — the violation is a
  //     type, not a syntax shape. `tsc` is the gate; see schema.ts.
  //   - "// @vitest-environment jsdom must be the FIRST line" — a comment
  //     position, invisible to the rule engine.
  //   - "_journal.json `when` must be monotonic" — data, not code.
  // ---------------------------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "instrumentation.ts"],
    // Tests hard-delete their own fixtures on purpose — that is cleanup, not a
    // soft-delete bypass, and every one of them scopes the delete to a tagged
    // test user. Seeds likewise truncate before reseeding.
    ignores: ["src/**/*.test.{ts,tsx}", "scripts/seed*.ts", "src/lib/db/seed/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Only the ten tables that actually carry deleted_at. A blanket ban
          // on db.delete() would be wrong: 34 of the 44 tables are hard-delete
          // by design (join tables, rebuilt caches, append-only logs), and a
          // rule that fires on those trains people to ignore it.
          // Keep this list in sync with the deletedAt columns in schema.ts.
          selector:
            "CallExpression[callee.property.name='delete'][arguments.0.name=/^(accounts|categories|transactions|statementImports|skippedConsolidationCycles|budgets|recurringTransactions|telegramBots|gmailConnections|emailReceipts)$/]",
          message:
            "This table carries deleted_at. Use an archive* action that sets it, and notDeleted() from src/lib/db/helpers.ts when reading. See engram 'soft-delete-not-deleted-helper'.",
        },
        {
          // drizzle-kit chokes on BigInt in its JSON snapshot.
          selector: "CallExpression[callee.property.name='default'] > Literal[bigint]",
          message:
            "A BigInt literal in .default() breaks db:generate (drizzle-kit serialises the snapshot as JSON). Use sql`0` instead of 0n.",
        },
        {
          // Anything outside the request lifecycle goes through src/lib/queue
          // (BullMQ + Redis). node-cron is removed from the project.
          selector:
            "CallExpression[callee.name='setInterval'], CallExpression[callee.object.name='cron'][callee.property.name='schedule'], CallExpression[callee.name='queueMicrotask']",
          message:
            "Background work goes through src/lib/queue (BullMQ + Redis), not setInterval / cron.schedule / queueMicrotask. Cron schedules are { repeat: { pattern, tz }, jobId } so restart is idempotent.",
        },
      ],
    },
  },
  {
    // Next.js 16 rejects a non-async export from a "use server" module at
    // runtime — exporting a Zod schema next to the actions 500s every action
    // in the file. Type-only exports are erased and stay legal.
    files: ["src/**/actions.ts", "src/**/actions.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ExportNamedDeclaration[exportKind!='type'] > VariableDeclaration > VariableDeclarator > *.init:not(ArrowFunctionExpression, FunctionExpression)",
          message:
            "A \"use server\" module may only export async functions. Move schemas, consts and type guards to a sibling file (e.g. actions-types.ts). See engram 'nextjs16-use-server-async-only'.",
        },
        {
          selector: "ExportNamedDeclaration[exportKind!='type'] > FunctionDeclaration[async=false]",
          message:
            "A \"use server\" module may only export async functions. See engram 'nextjs16-use-server-async-only'.",
        },
      ],
    },
  },
  // NOT a rule: "only tenant-isolation.test.ts may call db.$client.end()".
  // That engram memory predates #912, which gave every vitest worker its own
  // cloned database and its own client. Seven test files call it today and the
  // suite is green across 258 files, so the claim does not hold as an invariant
  // and encoding it would block working code. Left documented rather than
  // enforced — see the PR for #922 task 9.
  {
    // Account labels carry a disambiguating suffix. Reading account.name
    // directly is how #326 shipped two accounts that looked identical.
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "JSXExpressionContainer > MemberExpression[property.name='name'][object.name=/^(account|acct)$/]",
          message:
            "Render account labels with formatAccountLabel(account), never account.name. See engram 'prod-accounts-seeded-2026-04-19'.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scriptable widget scripts — they run in Scriptable's own JS runtime on
    // iOS with its own globals (Keychain, Request, Color, ListWidget, …) and
    // are served as static assets by Next.js (the in-app wizard at
    // /settings/widgets fetches them from here). Linting them against
    // next-ts rules produces false positives.
    "public/widgets/scriptable/**",
    // Claude Code tooling directory — agent worktrees, settings, transcripts.
    // Not source code; lint here would re-walk every isolated agent worktree.
    ".claude/**",
    // Classification eval harness — an offline research tool that runs under
    // bare Node, outside Next, and prints comparison tables for a human to read
    // in a terminal. Same reasoning as the Scriptable widgets above: different
    // runtime, different purpose. This is NOT a "scripts are special" carveout
    // on no-console — everything under src/ and scripts/ still logs through
    // Pino. See eval/README.md.
    "eval/**",
  ]),
]);

export default eslintConfig;
