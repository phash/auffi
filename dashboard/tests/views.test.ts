import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderLogin } from "../src/views/login.js";
import { renderSignup } from "../src/views/signup.js";
import { renderVerify } from "../src/views/verify.js";

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
  // Two ticks: one for the microtask the form-submit awaits, one for
  // any follow-up state update (queueMicrotask focus(), etc.).
  return new Promise((r) => setTimeout(r, 0));
}

describe("renderLogin", () => {
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

  it("renders email + password fields and a submit button", () => {
    const root = makeRoot();
    renderLogin(root, { path: "/login", segments: ["login"], params: {}, query: new URLSearchParams() });
    expect(root.querySelector("#login-email")).not.toBeNull();
    expect(root.querySelector("#login-password")).not.toBeNull();
    const btn = root.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(btn.textContent).toBe("Anmelden");
  });

  it("POSTs the credentials on submit + navigates to / on success", async () => {
    const root = makeRoot();
    const initialPath = window.location.pathname;
    renderLogin(root, { path: "/login", segments: ["login"], params: {}, query: new URLSearchParams() });
    const emailEl = root.querySelector("#login-email") as HTMLInputElement;
    const pwEl = root.querySelector("#login-password") as HTMLInputElement;
    const form = root.querySelector("form")!;
    emailEl.value = "user@example.test";
    pwEl.value = "verysecret1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(lastReq?.url).toBe("/api/auth/login");
    expect(JSON.parse(lastReq?.init.body as string)).toEqual({
      email: "user@example.test",
      password: "verysecret1",
    });
    // Navigated away from /login.
    expect(window.location.pathname).not.toBe(initialPath + "_unchanged");
  });

  it("shows a friendly message on bad-credentials", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "bad-credentials", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderLogin(root, { path: "/login", segments: ["login"], params: {}, query: new URLSearchParams() });
    const form = root.querySelector("form")!;
    (root.querySelector("#login-email") as HTMLInputElement).value = "a@b.test";
    (root.querySelector("#login-password") as HTMLInputElement).value = "wrongpassword";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const err = root.querySelector(".error") as HTMLElement;
    expect(err.textContent).toBe("E-Mail oder Passwort falsch.");
  });
});

describe("renderSignup", () => {
  beforeEach(() => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ ok: true }, 202)) as unknown as typeof fetch,
    });
  });
  afterEach(() => _setApiClientForTests(null));

  it("shows the success message and locks the form after a successful signup", async () => {
    const root = makeRoot();
    renderSignup(root, {
      path: "/signup",
      segments: ["signup"],
      params: {},
      query: new URLSearchParams(),
    });
    const form = root.querySelector("form")!;
    (root.querySelector("#signup-email") as HTMLInputElement).value = "new@a.test";
    (root.querySelector("#signup-password") as HTMLInputElement).value = "verysecret1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const success = root.querySelector('[role="status"]') as HTMLElement;
    expect(success.textContent).toContain("Bestätigungs-Mail unterwegs");
    expect((root.querySelector("#signup-email") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows 'email-taken' friendly message on 409", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "email-taken", message: "x" }, 409),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderSignup(root, {
      path: "/signup",
      segments: ["signup"],
      params: {},
      query: new URLSearchParams(),
    });
    const form = root.querySelector("form")!;
    (root.querySelector("#signup-email") as HTMLInputElement).value = "dup@a.test";
    (root.querySelector("#signup-password") as HTMLInputElement).value = "verysecret1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const err = root.querySelector(".error") as HTMLElement;
    expect(err.textContent).toContain("bereits registriert");
  });
});

describe("renderVerify", () => {
  afterEach(() => _setApiClientForTests(null));

  it("auto-fires GET on mount and shows success", async () => {
    let called = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        called = true;
        expect((init as RequestInit).method).toBe("GET");
        expect(input.toString()).toBe("/api/auth/verify/tok123");
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerify(root, {
      path: "/verify/tok123",
      segments: ["verify", "tok123"],
      params: { token: "tok123" },
      query: new URLSearchParams(),
    });
    await flush();
    expect(called).toBe(true);
    const status = root.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain("bestätigt");
    // Sec H-2: post-verify success points the user at /login, NOT
    // /devices — the backend doesn't auto-login anymore.
    const loginLink = root.querySelector('a[href$="/login"]') as HTMLAnchorElement;
    expect(loginLink).not.toBeNull();
    expect(loginLink.textContent).toContain("Anmeldung");
  });

  it("shows 'token-used' friendly message + link to login", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "token-used", message: "x" }, 410),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerify(root, {
      path: "/verify/x",
      segments: ["verify", "x"],
      params: { token: "x" },
      query: new URLSearchParams(),
    });
    await flush();
    const err = root.querySelector(".error") as HTMLElement;
    expect(err.textContent).toContain("bereits verwendet");
    const link = root.querySelector('a[href$="/login"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
  });

  it("guards against missing token", () => {
    const root = makeRoot();
    renderVerify(root, {
      path: "/verify/",
      segments: ["verify", ""],
      params: { token: "" },
      query: new URLSearchParams(),
    });
    const err = root.querySelector(".error") as HTMLElement;
    expect(err.textContent).toContain("unvollständig");
  });
});
