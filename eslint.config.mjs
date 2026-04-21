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
  ]),
]);

export default eslintConfig;
