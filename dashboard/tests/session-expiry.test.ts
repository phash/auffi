import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { BASE_PATH, type RouteRenderer } from "../src/router.js";
import { _resetSessionForTests, isAdmin, isLoggedIn, refreshSession } from "../src/session.js";
import { renderAccount } from "../src/views/account.js";
import { renderAddDevice } from "../src/views/add-device.js";
import { renderAdminFeedback } from "../src/views/admin-feedback.js";
import { renderAdminOverview } from "../src/views/admin-overview.js";
import { renderAdminStats } from "../src/views/admin-stats.js";
import { renderAdminUserDetail } from "../src/views/admin-user-detail.js";
import { renderAdminUsers } from "../src/views/admin-users.js";
import { renderConnectionLog } from "../src/views/connection-log.js";
import { renderDeviceDetail } from "../src/views/device-detail.js";
import { renderDevices } from "../src/views/devices.js";

// A 401 from any authed view means the session cookie expired. Besides
// bouncing to /login the view must re-probe the session, otherwise the
// cached admin flag keeps the "Admin" nav link and "Abmelden" visible.

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("expired session on an authed view", () => {
  afterEach(() => {
    _setApiClientForTests(null);
    _resetSessionForTests();
  });

  it.each<[string, RouteRenderer, Record<string, string>]>([
    ["devices", renderDevices, {}],
    ["devices/new", renderAddDevice, {}],
    ["devices/:id", renderDeviceDetail, { id: "dev-1" }],
    ["devices/:id/log", renderConnectionLog, { id: "dev-1" }],
    ["account", renderAccount, {}],
    ["admin", renderAdminOverview, {}],
    ["admin/stats", renderAdminStats, {}],
    ["admin/users", renderAdminUsers, {}],
    ["admin/users/:id", renderAdminUserDetail, { id: "7" }],
    ["admin/feedback", renderAdminFeedback, {}],
  ])("%s redirects to /login and drops the cached admin session", async (path, render, params) => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ id: 1, email: "a@b.test", admin: true }),
      ) as unknown as typeof fetch,
    });
    await refreshSession();
    expect(isAdmin()).toBe(true);

    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    window.history.pushState({}, "", `${BASE_PATH}/${path}`);
    render(makeRoot(), {
      path: `/${path}`,
      segments: path.split("/"),
      params,
      query: new URLSearchParams(),
    });
    await flush();

    expect(window.location.pathname).toBe(`${BASE_PATH}/login`);
    expect(isLoggedIn()).toBe(false);
    expect(isAdmin()).toBe(false);
  });
});
