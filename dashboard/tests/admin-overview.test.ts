import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAdminOverview } from "../src/views/admin-overview.js";
import type { RouteContext } from "../src/router.js";

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const ctx: RouteContext = {
  path: "/admin",
  segments: ["admin"],
  params: {},
  query: new URLSearchParams(),
};

const STATS = {
  users: { total: 12, verified: 10, suspended: 1, active_24h: 3, active_7d: 7, active_30d: 11, new_24h: 1, new_7d: 2 },
  devices: { total: 4, online_now: 1, paired_24h: 0 },
  connections: { today: 5, week: 22, p2p_today: 4, relay_today: 1, relay_bytes_today: 3 * 1024 * 1024 },
  system: { db_size_bytes: 1234567, uptime_seconds: 3600 },
};

const CODES = { total: 42, last24h: 5, last7d: 18, last30d: 33, perDay: [] };

afterEach(() => _setApiClientForTests(null));

describe("renderAdminOverview", () => {
  it("renders the KPI tiles and quick-links once both stats land", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/api/admin/stats")) return jsonResponse(STATS);
        if (u.endsWith("/api/admin/stats/codes")) return jsonResponse(CODES);
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminOverview(root, ctx);
    await flush();
    await flush();
    expect(root.querySelectorAll(".kpi-tile").length).toBe(6);
    expect(root.textContent).toContain("Code-Mints (24 h)");
    expect(root.querySelector('a[href="/dashboard/admin/users"]')).not.toBeNull();
  });

  it("shows the admin-only notice on 403", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "forbidden", message: "admin only" }, 403),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminOverview(root, ctx);
    await flush();
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain("Admin");
  });

  it("redirects to /login on 401", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminOverview(root, ctx);
    await flush();
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("does not navigate away after unmount when an in-flight request 401s", async () => {
    let release: null | (() => void) = null;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse({ error: "unauthorized" }, 401));
          }),
      ) as unknown as typeof fetch,
    });
    const before = window.location.pathname;
    const root = makeRoot();
    const cleanup = renderAdminOverview(root, ctx);
    await flush();
    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });
});
