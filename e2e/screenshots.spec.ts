import { test } from "@playwright/test";
import path from "node:path";

const pages = [
  { name: "home", path: "/" },
  { name: "transactions", path: "/transactions" },
  { name: "budgets", path: "/budgets" },
  { name: "insights", path: "/insights" },
  { name: "settings", path: "/settings" },
];

const modes = ["light", "dark"] as const;

for (const mode of modes) {
  for (const p of pages) {
    test(`screenshot: ${mode} ${p.name}`, async ({ page }) => {
      await page.addInitScript((m) => {
        window.localStorage.setItem("theme", m);
      }, mode);
      await page.goto(p.path);
      await page.waitForLoadState("networkidle");
      await page.screenshot({
        path: path.join("e2e/screenshots", `${mode}-${p.name}.png`),
        fullPage: true,
      });
    });
  }
}
