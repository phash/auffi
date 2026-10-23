/**
 * E2E: a well-formed code that no sharer registered. Exercises the real
 * path a mistyped code takes — TURN-credentials fetch, WSS join, the
 * backend's `invalid-code` error frame — and checks the helper sees plain
 * German instead of the raw protocol token. Needs the backend + viewer dev
 * server (CI starts both), no mock sharer.
 *
 * Every join counts against the backend's per-IP join budget
 * (RATE_LIMIT_MAX, 5/min in CI), so this spec joins exactly once.
 */
import { test, expect } from "@playwright/test";

test("an unknown code shows the friendly invalid-code copy and offers a retry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#code").fill("000-000-001");
  await page.locator("#connect").click();

  const status = page.locator("#status");
  await expect(status).toHaveText(
    "Dieser Code ist nicht (mehr) gültig. Bitte beim Helfer nach einem aktuellen Code fragen.",
  );
  await expect(status).toHaveClass("err");
  await expect(page.locator("#connect")).toBeEnabled();
  await expect(page.locator("#cancel-connect")).toBeHidden();
  await expect(page.locator("#reconnect-wrap")).toHaveClass(/active/);
});
