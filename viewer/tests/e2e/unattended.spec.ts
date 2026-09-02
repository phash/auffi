/**
 * E2E (gh #40): unattended-mode roundtrip across dashboard + backend
 * + viewer + a mock unattended sharer.
 *
 * Three tiers of coverage land in this file:
 *
 *   1. Dashboard auth surface — signup form posts to backend and
 *      hands over to the landing page with the toast flag; login
 *      form shows friendly bad-credentials on a wrong password.
 *      This tier needs only the backend + dashboard up; no mock
 *      sharer. Runs in CI (ci.yml e2e job starts both).
 *
 *   2. Pairing-code roundtrip — signup → verify (via backend test
 *      hook) → mint code → dashboard shows the code. Needs a
 *      backend test-mode hook to retrieve the captureTransport's
 *      last verify-email token, since intercepting real SMTP from
 *      Playwright is brittle. **Currently SKIPPED** — the backend
 *      test hook isn't wired (a future ticket: expose
 *      `GET /api/_test/last-mail` behind NODE_ENV=test).
 *
 *   3. Full sharer-paired roundtrip — boots a mock unattended
 *      sharer (`scripts/mock-unattended-sharer.mjs`, not yet
 *      written), pairs it, viewer hits ?code=… with the pairing
 *      code → password prompt → pw-ok → SDP/ICE exchange → stream
 *      stub. **Currently SKIPPED** — depends on (2) being wired
 *      AND on a mock sharer that speaks the gh #16-#18 protocol.
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

import { test, expect, type Page } from "@playwright/test";

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

test.describe("unattended pairing-code roundtrip (tier 2)", () => {
  test.beforeEach(() => {
    // Wire requires a backend-side test hook to read the captured
    // verify-email token — not landed yet. See file-level comment.
    test.skip(true, "Pending: backend GET /api/_test/last-mail hook");
  });

  test("signup → verify → mint pairing code → dashboard renders it", async (_p: { page: Page }) => {
    // Outline (once the test hook lands):
    //   const email = uniqueEmail();
    //   await signup(page, email, "e2e-pw-12345");
    //   const token = await fetch(`${BACKEND_HTTP_URL}/api/_test/last-mail`).then(r => r.json());
    //   await page.goto(`${DASHBOARD_URL}/dashboard/verify/${token}`);
    //   await expect(page.locator('[role="status"]')).toContainText("bestätigt");
    //   await page.goto(`${DASHBOARD_URL}/dashboard/devices/new`);
    //   await expect(page.locator('[aria-label="Pairing-Code"]')).toMatchText(/[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}/);
  });
});

test.describe("full sharer-paired roundtrip (tier 3)", () => {
  test.beforeEach(() => {
    test.skip(
      true,
      "Pending: scripts/mock-unattended-sharer.mjs (gh #16-#18 protocol).",
    );
  });

  test("mock sharer pairs → viewer connects with ?code=… → password prompt → stream", async (_p: { page: Page }) => {
    // Outline (once the mock sharer ships):
    //   1. Same signup + verify as tier 2.
    //   2. mint pairing code from dashboard.
    //   3. spawn(`node scripts/mock-unattended-sharer.mjs --code <code> --pw e2e-device-pw-1`)
    //      → waits for { device_id, token } from /api/devices/redeem, then
    //      opens WSS with Bearer auth, handles pw-check by replying pw-ok
    //      to anything matching --pw, otherwise pw-fail.
    //   4. await wait_for_line(mock, /unattended-hello/, 5_000).
    //   5. await page.goto(`${VIEWER_URL}/?code=${device_id}`);
    //   6. Code prefilled — click Verbinden.
    //   7. password prompt appears; fill e2e-device-pw-1; submit.
    //   8. await wait_for_line(mock, /pw-check-result.+ok/, 5_000).
    //   9. peer-confirmed → SDP/ICE → first frame of the mock track.
    //  10. cleanup: kill mock sharer.
  });
});
