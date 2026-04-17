import { test } from "@playwright/test";
import path from "node:path";

const pages = [
  { name: "home", path: "/", hasDonut: true },
  { name: "transactions", path: "/transactions", hasDonut: false },
  { name: "accounts", path: "/accounts", hasDonut: false },
  { name: "budgets", path: "/budgets", hasDonut: false },
  { name: "insights", path: "/insights", hasDonut: false },
  { name: "settings", path: "/settings", hasDonut: false },
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
      if (p.hasDonut) {
        await page
          .locator(".recharts-pie-sector path")
          .first()
          .waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(1_800);
      }
      await page.screenshot({
        path: path.join(
          "e2e/screenshots",
          `${projectName}-${mode}-${p.name}.png`,
        ),
        fullPage: true,
      });
    });
  }
}
