import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAdminStats } from "../src/views/admin-stats.js";

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const okStats = {
  users: {
    total: 12,
    verified: 10,
    suspended: 0,
    active_24h: 3,
    active_7d: 7,
    active_30d: 11,
    new_24h: 1,
    new_7d: 2,
  },
  devices: { total: 4, online_now: 1, paired_24h: 0 },
  connections: {
    today: 5,
    week: 22,
    p2p_today: 4,
    relay_today: 1,
    relay_bytes_today: 1024 * 1024 * 3,
  },
  system: { db_size_bytes: 1234567, uptime_seconds: 3600 },
};

const okCodes = {
  total: 42,
  last24h: 5,
  last7d: 18,
  last30d: 33,
  perDay: [
    { day: "2026-05-21", count: 5 },
    { day: "2026-05-20", count: 7 },
  ],
};

describe("renderAdminStats", () => {
  afterEach(() => _setApiClientForTests(null));

  it("shows a loading state until both responses land", () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(
        () => new Promise(() => undefined) as Promise<Response>,
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminStats(root, {
      path: "/admin/stats",
      segments: ["admin", "stats"],
      params: {},
      query: new URLSearchParams(),
    });
    expect((root.querySelector(".loading") as HTMLElement).textContent).toBe(
      "Lade Statistiken …",
    );
  });

  it("renders all four cards plus the perDay bars on a happy 200", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/api/admin/stats")) return jsonResponse(okStats);
        if (u.endsWith("/api/admin/stats/codes")) return jsonResponse(okCodes);
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminStats(root, {
      path: "/admin/stats",
      segments: ["admin", "stats"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    await flush();

    // Section headers come through
    const headings = Array.from(root.querySelectorAll("h2")).map(
      (h) => h.textContent ?? "",
    );
    expect(headings).toContain("Code-Mints (DB)");
    expect(headings).toContain("Nutzer");
    expect(headings).toContain("Geräte (Unattended)");
    expect(headings).toContain("Verbindungen");
    expect(headings).toContain("System");
    expect(headings).toContain("Code-Mints pro Tag (letzte 30 Tage)");

    // Code-mint total renders verbatim
    expect(root.textContent).toContain("42");
    expect(root.textContent).toContain("5"); // last24h
    // Per-day rows
    expect(root.querySelectorAll(".perday-row").length).toBe(2);
  });

  it("shows an admin-only notice on 403", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "forbidden", message: "admin only" }, 403),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminStats(root, {
      path: "/admin/stats",
      segments: ["admin", "stats"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    await flush();
    const err = root.querySelector(".error") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("Admin");
  });

  it("renders uptime as a duration, not an 'ago' phrase", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/api/admin/stats")) return jsonResponse(okStats);
        if (u.endsWith("/api/admin/stats/codes")) return jsonResponse(okCodes);
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminStats(root, {
      path: "/admin/stats",
      segments: ["admin", "stats"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    await flush();

    // uptime_seconds: 3600 → "1 Std" as a duration ("vor 1 Std" would be
    // a relative timestamp, semantically wrong for an uptime).
    expect(root.textContent).toContain("1 Std");
    expect(root.textContent).not.toContain("vor 1 Std");
  });

  it("renders an empty perDay block when codes.perDay is empty", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/api/admin/stats")) return jsonResponse(okStats);
        if (u.endsWith("/api/admin/stats/codes")) {
          return jsonResponse({ ...okCodes, perDay: [] });
        }
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminStats(root, {
      path: "/admin/stats",
      segments: ["admin", "stats"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    await flush();
    expect(root.querySelectorAll(".perday-row").length).toBe(0);
    expect(root.textContent).toContain("Noch keine Code-Mints");
  });
});
