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
