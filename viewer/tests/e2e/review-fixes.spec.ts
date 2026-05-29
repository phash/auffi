/**
 * E2E for the 2026-05-29 review fixes that need a real browser but NOT a full
 * WebRTC negotiation:
 *   - landing download buttons route through the same-origin proxy (DSGVO)
 *   - the Abbrechen button appears during the connect phase
 *   - an invalid code shows the German validation hint
 *
 * Prerequisite: viewer dev server (or set VIEWER_URL). No backend / sharer
 * needed — doConnect() shows the cancel control synchronously before any
 * network call, and the download/validation checks are DOM-only.
 */
import { test, expect } from "@playwright/test";

test.describe("review fixes (2026-05-29)", () => {
  test("landing Windows download buttons go through /api/downloads/file/, not github", async ({ page }) => {
    await page.goto("/");
    const dlLinks = page.locator('.download-buttons a[href*="/api/downloads/file/"]');
    await expect(dlLinks).toHaveCount(2);
    // No download button should link straight to GitHub release assets.
    await expect(
      page.locator('.download-buttons a[href*="releases/latest/download"], .download-buttons a[href*="releases/download/"]'),
    ).toHaveCount(0);
  });

  test("invalid code shows the German length hint", async ({ page }) => {
    await page.goto("/");
    await page.locator("#code").fill("123");
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Bitte 9-stelligen Code eingeben.");
  });

  test("Abbrechen button appears while connecting and cancels back to the form", async ({ page }) => {
    await page.goto("/");
    const cancel = page.locator("#cancel-connect");
    await expect(cancel).toBeHidden();

    await page.locator("#code").fill("123-456-789");
    await page.locator("#connect").click();

    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(cancel).toBeHidden();
    await expect(page.locator("#status")).toHaveText("Verbindung abgebrochen.");
  });
});
