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
    // Hold the connect in its "connecting" phase deterministically: stall the
    // TURN-credentials fetch so doConnect() never advances past it. Without
    // this the test races — against a reachable backend the invalid code is
    // rejected in a few ms (and against a refused port the WS closes just as
    // fast), tearing the Abbrechen control down before the assertion. The
    // control itself is shown synchronously by showConnectingControls(); we
    // just need the phase to persist long enough to observe + click it.
    await page.route("**/turn-credentials", () => {
      /* never fulfil — the request hangs, connect stays pending */
    });

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
