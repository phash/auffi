import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderForgot } from "../src/views/forgot.js";
import { renderReset } from "../src/views/reset.js";
import { BASE_PATH, createRouter, type Router } from "../src/router.js";
import {
  _resetSessionForTests,
  isAdmin,
  isLoggedIn,
  onSessionChange,
  refreshSession,
} from "../src/session.js";
import { renderLogin } from "../src/views/login.js";

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

describe("renderForgot", () => {
  let lastReq: { url: string; init: RequestInit } | null = null;
  beforeEach(() => {
    lastReq = null;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        lastReq = {
          url: typeof input === "string" ? input : input.toString(),
          init: init ?? {},
        };
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
  });
  afterEach(() => _setApiClientForTests(null));

  it("renders an email field + submit", () => {
    const root = makeRoot();
    renderForgot(root, {
      path: "/forgot",
      segments: ["forgot"],
      params: {},
      query: new URLSearchParams(),
    });
    expect(root.querySelector("#forgot-email")).not.toBeNull();
    expect(
      (root.querySelector("button[type=submit]") as HTMLButtonElement).textContent,
    ).toBe("Reset-Link schicken");
  });

  it("POSTs /api/auth/forgot and shows the generic success message", async () => {
    const root = makeRoot();
    renderForgot(root, {
      path: "/forgot",
      segments: ["forgot"],
      params: {},
      query: new URLSearchParams(),
    });
    (root.querySelector("#forgot-email") as HTMLInputElement).value = "a@b.test";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(lastReq?.url).toBe("/api/auth/forgot");
    const success = root.querySelector('[role="status"]') as HTMLElement;
    expect(success.textContent).toContain("Mail mit einem Reset-Link unterwegs");
    expect((root.querySelector("#forgot-email") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the rate-limit copy on 429 and leaves the form usable for a retry", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" }, 429),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderForgot(root, {
      path: "/forgot",
      segments: ["forgot"],
      params: {},
      query: new URLSearchParams(),
    });
    (root.querySelector("#forgot-email") as HTMLInputElement).value = "a@b.test";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect((root.querySelector('[role="alert"]') as HTMLElement).textContent).toBe(
      "Zu viele Versuche. Bitte später erneut versuchen.",
    );
    expect((root.querySelector('[role="status"]') as HTMLElement).textContent).toBe("");
    expect((root.querySelector("#forgot-email") as HTMLInputElement).disabled).toBe(false);
    const submit = root.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Reset-Link schicken");
  });
});

describe("renderReset", () => {
  let lastReq: { url: string; init: RequestInit } | null = null;
  beforeEach(() => {
    lastReq = null;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        // The success path re-probes /api/me; keep the reset POST as lastReq.
        if (url === "/api/me") return jsonResponse({ error: "no-session" }, 401);
        lastReq = { url, init: init ?? {} };
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
  });
  afterEach(() => {
    _setApiClientForTests(null);
    _resetSessionForTests();
  });

  it("POSTs the new password + token URL-encoded, then lands on /login with the notice", async () => {
    window.history.pushState({}, "", BASE_PATH + "/reset/tok%20123");
    const root = makeRoot();
    renderReset(root, {
      path: "/reset/tok 123",
      segments: ["reset", "tok 123"],
      params: { token: "tok 123" },
      query: new URLSearchParams(),
    });
    (root.querySelector("#reset-password") as HTMLInputElement).value = "newPassword1";
    (root.querySelector("#reset-password-confirm") as HTMLInputElement).value = "newPassword1";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(lastReq?.url).toBe("/api/auth/reset/tok%20123");
    expect(JSON.parse(lastReq?.init.body as string)).toEqual({ password: "newPassword1" });
    expect(window.location.pathname).toBe(BASE_PATH + "/login");
    expect(window.location.search).toBe("?reset=ok");
  });

  // A signed-in admin who opens the link: the reset kills this browser's
  // session too, the re-probe flips admin true->false and main.ts
  // re-renders the current route. The notice must survive that re-render
  // (the token is spent, so an empty reset form would be a dead end).
  it("keeps the success notice when the re-probe drops a signed-in admin", async () => {
    let reset = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input: unknown) => {
        if (String(input) === "/api/me") {
          return reset
            ? jsonResponse({ error: "no-session", message: "authentication required" }, 401)
            : jsonResponse({ id: 1, email: "a@b.test", admin: true });
        }
        reset = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await refreshSession();
    expect(isAdmin()).toBe(true);

    const root = makeRoot();
    window.history.pushState({}, "", BASE_PATH + "/reset/tok");
    const router: Router = createRouter(
      root,
      [
        { pattern: "/login", render: renderLogin },
        { pattern: "/reset/:token", render: renderReset },
      ],
      undefined,
      undefined,
      { isAdmin, isLoggedIn },
    );
    let wasAdmin = isAdmin();
    onSessionChange((session) => {
      if (session.admin !== wasAdmin) router.refresh();
      wasAdmin = session.admin;
    });
    router.start();
    try {
      (root.querySelector("#reset-password") as HTMLInputElement).value = "newPassword1";
      (root.querySelector("#reset-password-confirm") as HTMLInputElement).value = "newPassword1";
      root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      await flush();
      expect(isLoggedIn()).toBe(false);
      expect(isAdmin()).toBe(false);
      expect(window.location.pathname).toBe(BASE_PATH + "/login");
      const notice = root.querySelector('[role="status"]') as HTMLElement;
      expect(notice.textContent).toBe(
        "Passwort gesetzt. Alle Sitzungen wurden abgemeldet. Melde dich mit dem neuen Passwort an.",
      );
      expect(root.querySelector("#login-email")).not.toBeNull();
    } finally {
      router.stop();
    }
  });

  it("rejects mismatching confirm without hitting the network", async () => {
    let called = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        called = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderReset(root, {
      path: "/reset/x",
      segments: ["reset", "x"],
      params: { token: "x" },
      query: new URLSearchParams(),
    });
    (root.querySelector("#reset-password") as HTMLInputElement).value = "newPassword1";
    (root.querySelector("#reset-password-confirm") as HTMLInputElement).value = "different!";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(called).toBe(false);
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "nicht identisch",
    );
  });

  it("rejects short password without hitting the network", async () => {
    let called = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        called = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderReset(root, {
      path: "/reset/x",
      segments: ["reset", "x"],
      params: { token: "x" },
      query: new URLSearchParams(),
    });
    (root.querySelector("#reset-password") as HTMLInputElement).value = "short";
    (root.querySelector("#reset-password-confirm") as HTMLInputElement).value = "short";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(called).toBe(false);
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "mindestens 8 Zeichen",
    );
  });

  it("token-used: friendly message + link to /forgot", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "token-used", message: "x" }, 410),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderReset(root, {
      path: "/reset/x",
      segments: ["reset", "x"],
      params: { token: "x" },
      query: new URLSearchParams(),
    });
    (root.querySelector("#reset-password") as HTMLInputElement).value = "newPassword1";
    (root.querySelector("#reset-password-confirm") as HTMLInputElement).value = "newPassword1";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "bereits verwendet",
    );
    expect(root.querySelector('a[href$="/forgot"]')).not.toBeNull();
  });

  it("guards against missing token in the route", () => {
    const root = makeRoot();
    renderReset(root, {
      path: "/reset/",
      segments: ["reset", ""],
      params: { token: "" },
      query: new URLSearchParams(),
    });
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "unvollständig",
    );
    // Form should NOT be rendered when the token is missing.
    expect(root.querySelector("form")).toBeNull();
  });
});
