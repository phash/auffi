import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAdminUserDetail } from "../src/views/admin-user-detail.js";
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
  path: "/admin/users/7",
  segments: ["admin", "users", "7"],
  params: { id: "7" },
  query: new URLSearchParams(),
};

const USER = {
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

afterEach(() => _setApiClientForTests(null));

describe("renderAdminUserDetail", () => {
  it("renders the email header and the three action buttons", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(USER)) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await flush();
    expect((root.querySelector("h1") as HTMLElement).textContent).toBe("user@example.com");
    const labels = Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Suspendieren", "Zum Admin machen", "Löschen"]);
  });

  it("rejects a non-numeric id without hitting the network", () => {
    let called = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        called = true;
        return jsonResponse(USER);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUserDetail(root, { ...ctx, params: { id: "abc" } });
    expect(called).toBe(false);
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain("Ungültige");
  });

  it("surfaces a failed action inline instead of via window.alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return jsonResponse({ error: "last-admin", message: "cannot demote the last admin" }, 409);
        }
        return jsonResponse(USER);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await flush();
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Suspendieren")!.click();
    const textarea = document.querySelector(".admin-modal-reason") as HTMLTextAreaElement;
    textarea.value = "Grund lang genug für den Test";
    textarea.dispatchEvent(new Event("input"));
    (document.querySelector("#admin-modal-backdrop .btn.danger") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(alertSpy).not.toHaveBeenCalled();
    const err = root.querySelector('[role="alert"]') as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("cannot demote the last admin");
    alertSpy.mockRestore();
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
    const cleanup = renderAdminUserDetail(root, ctx);
    await flush();
    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });
});

// ── action flows + error surfaces + audit/devices rendering ─────────

type Call = { method: string; url: string; body: unknown };

/** Fake backend: GET returns the current user state, PATCH applies the action. */
function fakeBackend(
  initial: Record<string, unknown>,
  overrides: { patch?: () => Promise<Response>; del?: () => Response } = {},
): Call[] {
  let state: Record<string, unknown> = { ...initial };
  const calls: Call[] = [];
  _setApiClientForTests({
    base: "",
    fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(input), body });
      if (method === "PATCH") {
        if (overrides.patch) return overrides.patch();
        const action = (body as { action: string }).action;
        if (action === "suspend") state = { ...state, suspended_at: 1_700_000_100_000 };
        if (action === "unsuspend") state = { ...state, suspended_at: null };
        if (action === "promote") state = { ...state, admin: true };
        if (action === "demote") state = { ...state, admin: false };
        return jsonResponse({ ok: true });
      }
      if (method === "DELETE") {
        if (overrides.del) return overrides.del();
        return new Response(null, { status: 204 });
      }
      return jsonResponse(state);
    }) as unknown as typeof fetch,
  });
  return calls;
}

function button(scope: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(scope.querySelectorAll("button")).find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

function modalTitle(): string | null {
  return document.querySelector("#admin-modal-title")?.textContent ?? null;
}

function fillModalAndConfirm(reason = "Grund lang genug für den Test"): void {
  const textarea = document.querySelector(".admin-modal-reason") as HTMLTextAreaElement;
  textarea.value = reason;
  textarea.dispatchEvent(new Event("input"));
  (document.querySelector(
    "#admin-modal-backdrop .admin-modal-actions button:last-child",
  ) as HTMLButtonElement).click();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

function badges(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".user-badge")).map((b) => b.textContent ?? "");
}

describe("renderAdminUserDetail — actions", () => {
  it("suspends with the typed reason, refetches, and flips the button to Reaktivieren", async () => {
    const calls = fakeBackend(USER);
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Suspendieren").click();
    expect(modalTitle()).toBe("Suspendieren?");
    fillModalAndConfirm("Spam-Verdacht laut Report");
    await settle();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/admin/users/7");
    expect(patch?.body).toEqual({ action: "suspend", reason: "Spam-Verdacht laut Report" });
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(button(root, "Reaktivieren").disabled).toBe(false);
    expect(badges(root)).toContain("Suspendiert");
  });

  it("unsuspends a suspended user", async () => {
    const calls = fakeBackend({ ...USER, suspended_at: 1_700_000_000_000 });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Reaktivieren").click();
    expect(modalTitle()).toBe("Reaktivieren?");
    fillModalAndConfirm();
    await settle();
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ action: "unsuspend" });
    expect(button(root, "Suspendieren").disabled).toBe(false);
  });

  it("promotes a regular user and demotes an admin", async () => {
    const calls = fakeBackend(USER);
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Zum Admin machen").click();
    expect(modalTitle()).toBe("Promote?");
    fillModalAndConfirm();
    await settle();
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toMatchObject({ action: "promote" });
    expect(badges(root)).toContain("Admin");

    button(root, "Admin-Rechte entziehen").click();
    expect(modalTitle()).toBe("Demote?");
    fillModalAndConfirm();
    await settle();
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toMatchObject({ action: "demote" });
    expect(badges(root)).not.toContain("Admin");
  });

  it("does nothing when the modal is cancelled", async () => {
    const calls = fakeBackend(USER);
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Suspendieren").click();
    button(document.body, "Abbrechen").click();
    await settle();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(button(root, "Suspendieren").disabled).toBe(false);
    expect(document.querySelector("#admin-modal-backdrop")).toBeNull();
  });

  it("disables the action bar while a PATCH is in flight", async () => {
    let release: () => void = () => undefined;
    fakeBackend(USER, {
      patch: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ ok: true }));
        }),
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Suspendieren").click();
    fillModalAndConfirm();
    await flush();
    for (const label of ["Suspendieren", "Zum Admin machen", "Löschen"]) {
      expect(button(root, label).disabled, label).toBe(true);
    }
    release();
    await settle();
    expect(button(root, "Löschen").disabled).toBe(false);
  });

  it("clears a previous action error when the next action starts", async () => {
    let fail = true;
    fakeBackend(USER, {
      patch: async () =>
        fail
          ? jsonResponse({ error: "internal", message: "kaputt" }, 500)
          : new Promise<Response>(() => undefined),
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Suspendieren").click();
    fillModalAndConfirm();
    await settle();
    const err = root.querySelector('[role="alert"]') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe("Fehler: kaputt");

    fail = false;
    button(root, "Zum Admin machen").click();
    fillModalAndConfirm();
    await flush();
    expect(err.hidden).toBe(true);
    expect(err.textContent).toBe("");
  });

  it("hard-deletes with the reason and returns to the user list", async () => {
    const calls = fakeBackend(USER);
    window.history.pushState({}, "", "/dashboard/admin/users/7");
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Löschen").click();
    expect(modalTitle()).toBe("Account hart löschen?");
    fillModalAndConfirm("Nutzer hat Löschung angefragt");
    await settle();
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/api/admin/users/7");
    expect(del?.body).toEqual({ reason: "Nutzer hat Löschung angefragt" });
    expect(window.location.pathname).toBe("/dashboard/admin/users");
  });

  it("stays on the page and shows the error when the delete fails", async () => {
    fakeBackend(USER, {
      del: () => jsonResponse({ error: "last-admin", message: "cannot delete the last admin" }, 409),
    });
    window.history.pushState({}, "", "/dashboard/admin/users/7");
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Löschen").click();
    fillModalAndConfirm();
    await settle();
    expect(window.location.pathname).toBe("/dashboard/admin/users/7");
    expect((root.querySelector('[role="alert"]') as HTMLElement).textContent).toBe(
      "Fehler: cannot delete the last admin",
    );
    expect(button(root, "Löschen").disabled).toBe(false);
  });

  it("does not delete when the delete modal is cancelled", async () => {
    const calls = fakeBackend(USER);
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    button(root, "Löschen").click();
    button(document.body, "Abbrechen").click();
    await settle();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("renderAdminUserDetail — load errors", () => {
  it.each([
    [403, { error: "forbidden", message: "admin only" }, "Du musst Admin sein."],
    [404, { error: "not-found", message: "no such user" }, "Nutzer #7 nicht gefunden."],
    [500, { error: "internal", message: "kaputt" }, "Fehler: kaputt"],
  ])("HTTP %i shows its own copy and no action bar", async (status, body, expected) => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    expect((root.querySelector(".error") as HTMLElement).textContent).toBe(expected);
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("renderAdminUserDetail — sections", () => {
  function audit(id: number, after_json: string | null) {
    return { id, admin_id: 1, action: "suspend", created_at: 1_700_000_000_000, before_json: null, after_json };
  }

  it("shows the reason only for audit rows whose after_json carries one", async () => {
    fakeBackend({
      ...USER,
      recent_audits: [
        audit(1, JSON.stringify({ reason: "Spam" })),
        audit(2, JSON.stringify({ suspended: true })),
        audit(3, "{not json"),
        audit(4, null),
      ],
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    const auditCard = Array.from(root.querySelectorAll("section.card")).find((s) =>
      s.querySelector("h2")?.textContent?.startsWith("Admin-Audit-Spur"),
    );
    expect(auditCard?.querySelector("h2")?.textContent).toBe("Admin-Audit-Spur (4)");
    const rows = Array.from(auditCard?.querySelectorAll("li") ?? []);
    expect(rows.map((r) => r.querySelector("p")?.textContent ?? null)).toEqual([
      "Grund: Spam",
      null,
      null,
      null,
    ]);
  });

  it("renders empty states and the plain Aktiv marker for an unremarkable account", async () => {
    fakeBackend(USER);
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    expect(root.textContent).toContain("Keine gepairten Geräte.");
    expect(root.textContent).toContain("Noch keine Verbindungen.");
    expect(root.textContent).toContain("Keine Admin-Aktionen auf diesen Account.");
    expect(badges(root)).toEqual([]);
    expect(root.textContent).toContain("Aktiv");
  });

  it("labels devices by online state and renders the connection table", async () => {
    fakeBackend({
      ...USER,
      email_verified_at: null,
      devices: [
        { id: "d1", alias: "Laptop", last_seen_at: null, online: true },
        { id: "d2", alias: "Büro", last_seen_at: 1_700_000_000_000, online: false },
        { id: "d3", alias: "Alt", last_seen_at: null, online: false },
      ],
      recent_connections: [
        { id: 1, device_id: "d1", started_at: 1_700_000_000_000, ended_at: 1_700_000_065_000, connection_type: "p2p", bytes_relayed: 2048 },
        { id: 2, device_id: "d2", started_at: 1_700_000_000_000, ended_at: null, connection_type: "relay", bytes_relayed: 0 },
      ],
    });
    const root = makeRoot();
    renderAdminUserDetail(root, ctx);
    await settle();
    expect(badges(root)).toEqual(["Unverifiziert"]);
    expect(root.querySelector("h2")?.textContent).toBe("Aktionen");
    const deviceRows = Array.from(root.querySelectorAll("ul li")).map((li) => li.textContent ?? "");
    expect(deviceRows[0]).toBe("Laptop (d1)● Online");
    expect(deviceRows[1]).toContain("Zuletzt gesehen:");
    expect(deviceRows[2]).toBe("Alt (d3)Noch nie verbunden");
    const cells = Array.from(root.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
    );
    expect(cells).toHaveLength(2);
    expect(cells[0][0]).toBe("d1");
    expect(cells[0][2]).toBe("1:05 Min");
    expect(cells[0][4]).toBe("2.0 KB");
    expect(cells[1][2]).toBe("läuft");
    expect(cells[1][3]).toBe("relay");
  });
});
