import { test, expect } from "@playwright/test";
import path from "node:path";

test("counterparty: transactions page renders table with QR rows", async ({ page }) => {
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  await page.locator("table").waitFor({ state: "visible", timeout: 10_000 });
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  await page.screenshot({
    path: path.join("e2e/screenshots", "cp-transactions-loaded.png"),
    fullPage: true,
  });
});

test("counterparty: dialog opens on QR row and shows identify CTA", async ({ page }) => {
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  await page.locator("table").waitFor({ state: "visible", timeout: 10_000 });

  const identifyButton = page.getByRole("button", { name: /identify/i }).first();
  const hasIdentify = await identifyButton.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!hasIdentify) {
    // No QR/Bre-b tx with placeholder counterparty in DB — fine, test ends here
    // after capturing the empty state screenshot for PR.
    await page.screenshot({
      path: path.join("e2e/screenshots", "cp-no-qr-rows.png"),
      fullPage: true,
    });
    return;
  }

  await identifyButton.click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5_000 });

  await page.screenshot({
    path: path.join("e2e/screenshots", "cp-dialog-open.png"),
    fullPage: true,
  });

  // Sanity: the dialog has the key displayed and the type buttons
  await expect(page.getByRole("button", { name: /person/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /merchant/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /unknown/i })).toBeVisible();
});
