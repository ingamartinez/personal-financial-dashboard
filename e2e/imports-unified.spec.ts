/**
 * Capture-only screenshots for the unified /imports surface (#584).
 *
 * Covers six scenarios:
 *   1. imports-bare      — /imports with no hints (shows empty drop-zone + account dropdown)
 *   2. imports-hint-arq  — /imports?hint_account_id=7 (ARQ USD account pre-selected)
 *   3. imports-hint-bc   — /imports?hint_account_id=3 (Bancolombia savings account pre-selected)
 *   4. imports-hint-tc   — /imports?hint_account_id=5&hint_cycle=2026-03 (TC detallado deep-link)
 *   5. reconcile-cta     — /settings/accounts/3/reconcile (Phase 2: deep-link CTA, legacy form in details)
 *   6. consolidate-cta   — /settings/accounts/5/consolidate/2026-03 (Phase 2: deep-link CTA)
 *
 * No login → every scenario lands on the auth redirect or the actual page depending on
 * DEV_AUTH_BYPASS. Either way we capture what the browser renders — useful for visual diffs.
 */

import { test } from "@playwright/test";
import path from "node:path";

const scenarios = [
  { name: "imports-bare", path: "/imports" },
  { name: "imports-hint-arq", path: "/imports?hint_account_id=7" },
  { name: "imports-hint-bc", path: "/imports?hint_account_id=3" },
  { name: "imports-hint-tc", path: "/imports?hint_account_id=5&hint_cycle=2026-03" },
  { name: "reconcile-cta", path: "/settings/accounts/3/reconcile" },
  { name: "consolidate-cta", path: "/settings/accounts/5/consolidate/2026-03" },
];

const modes = ["light", "dark"] as const;

for (const mode of modes) {
  for (const s of scenarios) {
    test(`imports-unified: ${mode} ${s.name}`, async ({ page }, testInfo) => {
      const projectName = testInfo.project.name;
      await page.addInitScript((m) => {
        window.localStorage.setItem("theme", m);
      }, mode);
      await page.goto(s.path, { waitUntil: "load" });
      // Allow streamed server-component content to settle.
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join("e2e/screenshots", `${projectName}-${mode}-${s.name}.png`),
        fullPage: true,
      });
    });
  }
}
