/**
 * E2E (gh #40): the dashboard auth surface of the unattended-access mode —
 * signup form posts to the backend and shows the success banner; login
 * shows friendly bad-credentials on a wrong password; forgot-password
 * always answers with the generic banner. Needs only the backend +
 * dashboard up; no mock sharer.
 *
 * Not covered here (see tests/e2e/README.md § Known gaps): the pairing-code
 * roundtrip (needs a NODE_ENV=test-only hook that exposes the captured
 * verify-mail token) and the full sharer-paired roundtrip (needs a mock
 * unattended sharer that speaks the pw-check protocol).
 *
 * Env vars:
 *   BACKEND_HTTP_URL  default http://localhost:8080
 *   DASHBOARD_URL     default http://localhost:5174
 *   VIEWER_URL        default http://localhost:5173 (also read by
 *                      playwright.config.ts)
 *
 * Run with backend + dashboard up:
 *   cd backend && AUFFI_DB_PATH=:memory: npm run dev &
 *   cd dashboard && npm run dev &
 *   cd viewer && npm run dev &
 *   cd viewer && npx playwright test unattended.spec.ts
 */

import { test, expect } from "@playwright/test";

const BACKEND_HTTP_URL = process.env.BACKEND_HTTP_URL ?? "http://localhost:8080";
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:5174";

/**
 * Probe whether a service is up. Returns true on the first 200/3xx
 * we get; false otherwise. We're not picky about which path responds
 * — `/` is the most universally available, and the dashboard's `/`
 * returns the SPA shell.
 */
async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function backendUp(): Promise<boolean> {
  return isUp(BACKEND_HTTP_URL + "/healthz");
}

async function dashboardUp(): Promise<boolean> {
  return isUp(DASHBOARD_URL + "/");
}

function uniqueEmail(): string {
  // Unique per-run so re-running the suite doesn't 409 on the
  // email-taken check from the previous attempt.
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;
}

test.describe("dashboard auth surface (tier 1)", () => {
  test.beforeEach(async ({}, info) => {
    const back = await backendUp();
    const dash = await dashboardUp();
    // Locally a missing service is a skip. In CI it must be a failure:
    // the e2e job claims to cover this tier, and a silent skip turned the
    // gate hollow for months (backend + viewer were started, the
    // dashboard never was — every tier-1 test skipped, job green).
    if (process.env.CI && (!back || !dash)) {
      throw new Error(
        `CI must bring up backend + dashboard before this spec ` +
          `(backend=${back} dashboard=${dash}, ${BACKEND_HTTP_URL} / ${DASHBOARD_URL})`,
      );
    }
    test.skip(
      !back || !dash,
      `Skipping: backend up=${back} dashboard up=${dash}. Bring both ` +
        `up first (see file-level comment).`,
    );
    info.annotations.push({ type: "stack", description: `${BACKEND_HTTP_URL} + ${DASHBOARD_URL}` });
  });

  test("signup form POSTs, then hands over to the landing page with the toast flag", async ({ page }) => {
    const email = uniqueEmail();
    await page.goto(DASHBOARD_URL + "/dashboard/signup");
    await page.locator("#signup-email").fill(email);
    await page.locator("#signup-password").fill("e2e-pw-12345");
    const signupResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/auth/signup") && res.request().method() === "POST",
    );
    await page.locator("button[type=submit]").click();
    expect((await signupResponse).status()).toBe(202);
    // On success the view leaves the dashboard SPA for the viewer's landing
    // page ("/") and sets the one-shot flag signup-toast.ts renders there
    // (dashboard/src/views/signup.ts). Same origin, so the flag is readable
    // from wherever "/" lands in the dev layout.
    await page.waitForURL((url) => !url.pathname.endsWith("/signup"), { timeout: 10_000 });
    expect(await page.evaluate(() => window.sessionStorage.getItem("auffi:signup-toast"))).toBe("1");
  });

  test("login shows friendly bad-credentials on wrong password", async ({ page }) => {
    await page.goto(DASHBOARD_URL + "/dashboard/login");
    await page.locator("#login-email").fill("nobody@e2e.test");
    await page.locator("#login-password").fill("wrongpassword");
    await page.locator("button[type=submit]").click();
    await expect(page.locator(".error")).toContainText(
      "E-Mail oder Passwort falsch",
      { timeout: 10_000 },
    );
  });

  test("forgot-password form always shows the generic success banner", async ({ page }) => {
    await page.goto(DASHBOARD_URL + "/dashboard/forgot");
    await page.locator("#forgot-email").fill(uniqueEmail());
    await page.locator("button[type=submit]").click();
    await expect(page.locator('[role="status"]')).toContainText(
      "Mail mit einem Reset-Link unterwegs",
      { timeout: 10_000 },
    );
  });
});
