/* Visual audit of the live Engineering-Brief redesign on auffi.app.
 * Run with:  npx playwright test /tmp/visual-audit.spec.ts --config=playwright.config.ts --reporter=list
 * Screenshots land in /tmp/visual-audit/.
 */
import { test, expect, devices } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = "/tmp/visual-audit";
fs.mkdirSync(OUT, { recursive: true });

const PAGES: Array<{ name: string; url: string }> = [
  { name: "viewer-home", url: "https://auffi.app/" },
  { name: "viewer-impressum", url: "https://auffi.app/impressum/" },
  { name: "viewer-datenschutz", url: "https://auffi.app/datenschutz/" },
  { name: "viewer-download", url: "https://auffi.app/download/" },
  { name: "dashboard-login", url: "https://auffi.app/dashboard/login" },
  { name: "dashboard-signup", url: "https://auffi.app/dashboard/signup" },
  { name: "dashboard-forgot", url: "https://auffi.app/dashboard/forgot" },
];

for (const { name, url } of PAGES) {
  test(`screenshot light ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({
      path: path.join(OUT, `${name}-light.png`),
      fullPage: true,
    });
  });

  test(`screenshot dark ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({
      path: path.join(OUT, `${name}-dark.png`),
      fullPage: true,
    });
  });

  test(`screenshot mobile ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({
      path: path.join(OUT, `${name}-mobile.png`),
      fullPage: true,
    });
  });
}

// Password eye-toggle exercise.
test("password eye-toggle on /dashboard/login", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("https://auffi.app/dashboard/login", { waitUntil: "networkidle" });

  // Initial state — password hidden, eye open.
  const pw = page.locator("#login-password");
  await pw.fill("hunter2-test");
  await page.screenshot({
    path: path.join(OUT, "pw-toggle-1-hidden.png"),
    fullPage: false,
    clip: { x: 0, y: 100, width: 1440, height: 500 },
  });

  // Click the eye toggle, capture revealed state.
  const eye = page.locator("#login-password + .password-toggle, .password-wrap .password-toggle").first();
  await eye.click();
  await page.screenshot({
    path: path.join(OUT, "pw-toggle-2-visible.png"),
    fullPage: false,
    clip: { x: 0, y: 100, width: 1440, height: 500 },
  });

  // Click again to hide; verify the eye reverts.
  await eye.click();
  await page.screenshot({
    path: path.join(OUT, "pw-toggle-3-hidden-again.png"),
    fullPage: false,
    clip: { x: 0, y: 100, width: 1440, height: 500 },
  });

  // Sanity: input type should be "password" now.
  expect(await pw.getAttribute("type")).toBe("password");
});

// Notch button — click on impressum should navigate to / with #code.
test("notch button focus flow from impressum", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("https://auffi.app/impressum/", { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(OUT, "notch-1-impressum-top.png"),
    fullPage: false,
    clip: { x: 0, y: 0, width: 1440, height: 200 },
  });
  await page.locator(".topbar-notch").click();
  await page.waitForLoadState("networkidle");
  // Should land on /#code with the code input focused.
  await page.screenshot({
    path: path.join(OUT, "notch-2-after-navigation.png"),
    fullPage: false,
    clip: { x: 0, y: 0, width: 1440, height: 600 },
  });
});

// Matomo consent banner — fresh visit on a clean profile shows it.
test("matomo consent banner on first visit", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    // Force-clear any cached consent: fresh ephemeral context.
  });
  const page = await ctx.newPage();
  await page.goto("https://auffi.app/", { waitUntil: "networkidle" });
  // Give the banner a beat to mount.
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(OUT, "matomo-consent-banner.png"),
    fullPage: false,
    clip: { x: 0, y: 500, width: 1440, height: 400 },
  });
  await ctx.close();
});
