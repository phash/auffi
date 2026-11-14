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

// Same contract for the mutations: a cookie that expires while the view is
// open must not surface as "Fehler: authentication required".

const ME = {
  id: 1,
  email: "owner@a.test",
  admin: true,
  emailVerifiedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  pendingEmail: null,
  pendingEmailExpiresAt: null,
};

const DEVICE = {
  id: "dev-1",
  alias: "Laptop",
  autoAccept: true,
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
  online: true,
};

const ADMIN_USER = {
  id: 7,
  email: "user@example.com",
  admin: false,
  suspended_at: null,
  email_verified_at: 123,
  created_at: 1_700_000_000_000,
  devices: [],
  recent_connections: [],
  recent_audits: [],
};

const FEEDBACK = {
  id: 1,
  accountId: 7,
  accountEmail: "user@example.com",
  source: "dashboard",
  category: "bug",
  rating: 4,
  body: "Feedback",
  userAgentHint: null,
  createdAt: 1_700_000_000_000,
  resolvedAt: null,
  replyBody: null,
  repliedAt: null,
  repliedBy: null,
  replySentAt: null,
};

/** Loads answer 200 until the first mutation; from then on the session is gone. */
function backendThatExpiresOnMutation(): void {
  let expired = false;
  _setApiClientForTests({
    base: "",
    fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") expired = true;
      if (expired) {
        return jsonResponse({ error: "no-session", message: "authentication required" }, 401);
      }
      if (url === "/api/me") return jsonResponse(ME);
      if (url === "/api/devices") return jsonResponse({ items: [DEVICE] });
      if (url.startsWith("/api/admin/users/")) return jsonResponse(ADMIN_USER);
      if (url.startsWith("/api/admin/feedback")) return jsonResponse({ items: [FEEDBACK], nextCursor: null });
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch,
  });
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

function input(selector: string, value: string): void {
  (document.querySelector(selector) as HTMLInputElement).value = value;
}

function submitFormOf(selector: string): void {
  (document.querySelector(selector) as HTMLElement)
    .closest("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

function confirmStyledDialog(): void {
  (document.querySelector("#admin-modal-backdrop .btn.danger") as HTMLButtonElement).click();
}

function confirmWithTypedReason(): void {
  const textarea = document.querySelector(".admin-modal-reason") as HTMLTextAreaElement;
  textarea.value = "Grund lang genug für den Test";
  textarea.dispatchEvent(new Event("input"));
  (document.querySelector(
    "#admin-modal-backdrop .admin-modal-actions button:last-child",
  ) as HTMLButtonElement).click();
}

describe("expired session on a mutation", () => {
  afterEach(() => {
    _setApiClientForTests(null);
    _resetSessionForTests();
    document.getElementById("admin-modal-backdrop")?.remove();
  });

  it.each<[string, string, RouteRenderer, Record<string, string>, () => Promise<void>]>([
    ["device alias", "devices/dev-1", renderDeviceDetail, { id: "dev-1" }, async () => {
      input("#dev-alias", "Neuer Name");
      submitFormOf("#dev-alias");
    }],
    ["device auto-accept", "devices/dev-1", renderDeviceDetail, { id: "dev-1" }, async () => {
      (document.querySelector("#dev-auto-accept") as HTMLInputElement).click();
    }],
    ["device delete", "devices/dev-1", renderDeviceDetail, { id: "dev-1" }, async () => {
      button("Gerät entkoppeln").click();
      await flush();
      confirmStyledDialog();
    }],
    ["account email", "account", renderAccount, {}, async () => {
      input("#acc-new-email", "next@a.test");
      input("#acc-email-current-pw", "verysecret1");
      submitFormOf("#acc-new-email");
    }],
    ["account password", "account", renderAccount, {}, async () => {
      input("#acc-current-pw", "verysecret1");
      input("#acc-new-pw", "newpassword2");
      submitFormOf("#acc-current-pw");
    }],
    ["account delete", "account", renderAccount, {}, async () => {
      input("#acc-confirm", "LÖSCHEN");
      input("#acc-delete-pw", "verysecret1");
      submitFormOf("#acc-confirm");
    }],
    ["admin user action", "admin/users/7", renderAdminUserDetail, { id: "7" }, async () => {
      button("Suspendieren").click();
      confirmWithTypedReason();
    }],
    ["admin user delete", "admin/users/7", renderAdminUserDetail, { id: "7" }, async () => {
      button("Löschen").click();
      confirmWithTypedReason();
    }],
    ["admin feedback toggle", "admin/feedback", renderAdminFeedback, {}, async () => {
      button("Erledigen").click();
    }],
    ["admin feedback delete", "admin/feedback", renderAdminFeedback, {}, async () => {
      button("Löschen").click();
      await flush();
      confirmStyledDialog();
    }],
    ["admin feedback reply", "admin/feedback", renderAdminFeedback, {}, async () => {
      button("Antworten").click();
      (document.querySelector("textarea") as HTMLTextAreaElement).value = "Danke!";
      button("Senden").click();
    }],
  ])("%s redirects to /login and drops the cached session", async (_name, path, render, params, act) => {
    backendThatExpiresOnMutation();
    await refreshSession();
    expect(isAdmin()).toBe(true);
    window.history.pushState({}, "", `${BASE_PATH}/${path}`);
    const root = makeRoot();
    render(root, {
      path: `/${path}`,
      segments: path.split("/"),
      params,
      query: new URLSearchParams(),
    });
    await flush();

    await act();
    await flush();

    expect(window.location.pathname).toBe(`${BASE_PATH}/login`);
    expect(isLoggedIn()).toBe(false);
    expect(root.textContent).not.toContain("authentication required");
  });

  it("rolls the auto-accept toggle back before redirecting", async () => {
    backendThatExpiresOnMutation();
    window.history.pushState({}, "", `${BASE_PATH}/devices/dev-1`);
    renderDeviceDetail(makeRoot(), {
      path: "/devices/dev-1",
      segments: ["devices", "dev-1"],
      params: { id: "dev-1" },
      query: new URLSearchParams(),
    });
    await flush();
    const toggle = document.querySelector("#dev-auto-accept") as HTMLInputElement;
    toggle.click();
    await flush();
    expect(toggle.checked).toBe(true);
  });
});
