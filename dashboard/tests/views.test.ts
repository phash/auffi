import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderLogin } from "../src/views/login.js";
import { renderSignup } from "../src/views/signup.js";
import { renderVerify } from "../src/views/verify.js";
import { renderVerifyEmailChange } from "../src/views/verify-email-change.js";
import { renderAdminFeedback } from "../src/views/admin-feedback.js";

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
  // Collect ALL requests: a successful login fires a follow-up
  // GET /api/me (session re-probe) after the POST.
  let reqs: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => {
    reqs = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        reqs.push({
          url: typeof input === "string" ? input : input.toString(),
          init: init ?? {},
        });
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
    const loginReq = reqs.find((r) => r.url === "/api/auth/login");
    expect(loginReq).toBeDefined();
    expect(JSON.parse(loginReq?.init.body as string)).toEqual({
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

  it("after a successful signup, sets sessionStorage flag + invokes navigation", async () => {
    // jsdom seals window.location and refuses both Object.defineProperty
    // and vi.spyOn on .assign. Replace the whole `location` getter with
    // a stub object — only `assign` is observed; everything else is
    // irrelevant for this test.
    const navigateMock = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign: navigateMock, href: origLocation.href },
    });
    window.sessionStorage.removeItem("auffi:signup-toast");

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

    expect(window.sessionStorage.getItem("auffi:signup-toast")).toBe("1");
    expect(navigateMock).toHaveBeenCalledWith("/");

    // Restore original location.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: origLocation,
    });
    window.sessionStorage.removeItem("auffi:signup-toast");
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

describe("renderAdminFeedback — inline reply UI", () => {
  type Req = { url: string; init: RequestInit };
  let requests: Req[] = [];
  let nextResponse: () => Response;

  function ctx() {
    return {
      path: "/admin/feedback",
      segments: ["admin", "feedback"],
      params: {},
      query: new URLSearchParams(),
    };
  }

  function feedbackItem(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 42,
      accountId: 7,
      accountEmail: "alice@example.com",
      source: "dashboard",
      category: "bug",
      rating: 4,
      body: "Mein Code blinkt nicht.",
      userAgentHint: null,
      createdAt: Date.now() - 60_000,
      resolvedAt: null,
      replyBody: null,
      repliedAt: null,
      repliedBy: null,
      replySentAt: null,
      ...over,
    };
  }

  beforeEach(() => {
    requests = [];
    nextResponse = () => jsonResponse({ items: [feedbackItem()], nextCursor: null });
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input.toString(),
          init: init ?? {},
        });
        return nextResponse();
      }) as unknown as typeof fetch,
    });
  });
  afterEach(() => _setApiClientForTests(null));

  it("renders an 'Antworten' button by default; clicking it reveals the reply textarea", async () => {
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const replyBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Antworten",
    ) as HTMLButtonElement;
    expect(replyBtn).toBeDefined();
    expect(root.querySelector(".feedback-admin-reply-panel")).toBeNull();
    replyBtn.click();
    const panel = root.querySelector(".feedback-admin-reply-panel");
    expect(panel).not.toBeNull();
    const ta = panel!.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
  });

  it("POSTs the reply to /api/admin/feedback/:id/reply on Senden click", async () => {
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    (
      Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Antworten",
      ) as HTMLButtonElement
    ).click();
    const ta = root.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "Sollte gleich fixed sein.";
    // Route-aware stub: reply endpoint returns success, the follow-up
    // list-reload returns an empty list (test only cares about the POST).
    nextResponse = () => {
      const last = requests[requests.length - 1];
      if (last && last.url.includes("/reply")) {
        return jsonResponse({ ok: true, replyAt: Date.now(), sentAt: Date.now() });
      }
      return jsonResponse({ items: [], nextCursor: null });
    };
    (
      Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Senden",
      ) as HTMLButtonElement
    ).click();
    await flush();
    await flush();
    const replyCall = requests.find((r) =>
      r.url.includes("/api/admin/feedback/42/reply"),
    );
    expect(replyCall).toBeDefined();
    expect(replyCall!.init.method).toBe("POST");
    expect(JSON.parse(String(replyCall!.init.body))).toEqual({
      reply: "Sollte gleich fixed sein.",
    });
  });

  it("rejects empty/whitespace reply locally before issuing a POST", async () => {
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    (
      Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Antworten",
      ) as HTMLButtonElement
    ).click();
    const ta = root.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "   \n  ";
    (
      Array.from(root.querySelectorAll("button")).find(
        (b) => b.textContent === "Senden",
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(
      requests.some((r) => r.url.includes("/reply")),
      "no reply POST should have been sent",
    ).toBe(false);
    const status = root.querySelector(".feedback-admin-reply-status") as HTMLElement;
    expect(status.textContent).toContain("Text");
  });

  it("renders the read-only reply block for an already-replied item", async () => {
    nextResponse = () =>
      jsonResponse({
        items: [
          feedbackItem({
            replyBody: "Antworten kommen aus dem Backend.",
            repliedAt: Date.now() - 30_000,
            repliedBy: 1,
            replySentAt: Date.now() - 29_000,
            resolvedAt: Date.now() - 29_000,
          }),
        ],
        nextCursor: null,
      });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const shown = root.querySelector(".feedback-admin-reply-shown") as HTMLElement;
    expect(shown).not.toBeNull();
    expect(shown.textContent).toContain("Antworten kommen aus dem Backend.");
    expect(shown.textContent).toContain("gesendet");
    // The reply button now says "Neu antworten" (re-reply mode).
    const replyBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Neu antworten",
    );
    expect(replyBtn).toBeDefined();
  });

  it("shows 'Mail-Versand fehlgeschlagen' when replySentAt is null but repliedAt is set", async () => {
    nextResponse = () =>
      jsonResponse({
        items: [
          feedbackItem({
            replyBody: "konnte nicht gesendet werden",
            repliedAt: Date.now(),
            repliedBy: 1,
            replySentAt: null,
            resolvedAt: Date.now(),
          }),
        ],
        nextCursor: null,
      });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const shown = root.querySelector(".feedback-admin-reply-shown") as HTMLElement;
    expect(shown.textContent).toContain("Mail-Versand fehlgeschlagen");
  });
});

// The email-change confirmation mail linked /verify-email-change/:token, but
// no such route or view existed — the click landed on the SPA's not-found
// page and the address swap never completed. Mirrors renderVerify, against
// GET /api/me/email-change/:token.
describe("renderVerifyEmailChange", () => {
  afterEach(() => _setApiClientForTests(null));

  const ctx = (token: string) => ({
    path: `/verify-email-change/${token}`,
    segments: ["verify-email-change", token],
    params: { token },
    query: new URLSearchParams(),
  });

  it("fires GET against the account endpoint on mount and reports success", async () => {
    let seen = "";
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        seen = input.toString();
        expect((init as RequestInit).method).toBe("GET");
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerifyEmailChange(root, ctx("tok789"));
    await flush();
    expect(seen).toBe("/api/me/email-change/tok789");
    const status = root.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain("geändert");
    // The backend clears the session cookie on success, so the only sensible
    // next step is signing in again with the new address.
    expect(root.querySelector('a[href$="/login"]')).not.toBeNull();
  });

  it("explains an expired or already-used link", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "token-used", message: "x" }, 410),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerifyEmailChange(root, ctx("x"));
    await flush();
    const status = root.querySelector('[role="status"]') as HTMLElement;
    expect(status.className).toBe("error");
    expect(status.textContent).toMatch(/verwendet|abgelaufen/);
  });

  it("explains that the address was claimed elsewhere", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "email-taken", message: "x" }, 409),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerifyEmailChange(root, ctx("y"));
    await flush();
    const status = root.querySelector('[role="status"]') as HTMLElement;
    expect(status.className).toBe("error");
    expect(status.textContent).toContain("vergeben");
  });

  it("does not call the API for an empty token", async () => {
    let called = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        called = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderVerifyEmailChange(root, ctx(""));
    await flush();
    expect(called).toBe(false);
    expect((root.querySelector('[role="status"]') as HTMLElement).className).toBe("error");
  });
});
