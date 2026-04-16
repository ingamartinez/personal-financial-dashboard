import { test } from "@playwright/test";
import path from "node:path";

const pages = [
  { name: "home", path: "/" },
  { name: "transactions", path: "/transactions" },
  { name: "budgets", path: "/budgets" },
  { name: "insights", path: "/insights" },
  { name: "settings", path: "/settings" },
];

for (const p of pages) {
  test(`screenshot: ${p.name}`, async ({ page }) => {
    await page.goto(p.path);
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join("e2e/screenshots", `${p.name}.png`),
      fullPage: true,
    });
  });
}
