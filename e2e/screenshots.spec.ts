import { test } from "@playwright/test";
import path from "node:path";

const pages = [
  { name: "home", path: "/", hasDonut: true },
  { name: "transactions", path: "/transactions", hasDonut: false },
  { name: "accounts", path: "/accounts", hasDonut: false },
  { name: "budgets", path: "/budgets", hasDonut: false },
  { name: "insights", path: "/insights", hasDonut: false },
  { name: "settings", path: "/settings", hasDonut: false },
  { name: "settings-ingestion", path: "/settings/ingestion", hasDonut: false },
  { name: "settings-rules", path: "/settings/rules", hasDonut: false },
  { name: "settings-inbox", path: "/settings/inbox", hasDonut: false },
  { name: "settings-widgets", path: "/settings/widgets", hasDonut: false },
  { name: "signup-missing", path: "/signup", hasDonut: false },
  { name: "signup-unknown", path: "/signup?code=__DOESNOTEXIST__", hasDonut: false },
];

const modes = ["light", "dark"] as const;

for (const mode of modes) {
  for (const p of pages) {
    test(`screenshot: ${mode} ${p.name}`, async ({ page }, testInfo) => {
      const projectName = testInfo.project.name;
      await page.addInitScript((m) => {
        window.localStorage.setItem("theme", m);
      }, mode);
      await page.goto(p.path, { waitUntil: "load" });
      // Wait for streamed server-component content to replace any loading.tsx skeleton.
      await page.waitForTimeout(600);
      if (p.hasDonut) {
        await page
          .locator(".recharts-pie-sector path")
          .first()
          .waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(1_800);
      }
      await page.screenshot({
        path: path.join("e2e/screenshots", `${projectName}-${mode}-${p.name}.png`),
        fullPage: true,
      });
    });
  }
}
