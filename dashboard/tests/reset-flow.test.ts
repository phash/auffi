import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderForgot } from "../src/views/forgot.js";
import { renderReset } from "../src/views/reset.js";

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
});

describe("renderReset", () => {
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

  it("POSTs the new password + token URL-encoded, shows success + login link", async () => {
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
    const success = root.querySelector('[role="status"]') as HTMLElement;
    expect(success.textContent).toContain("Passwort gesetzt");
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
