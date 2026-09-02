import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { friendlyAccountError, renderAccount } from "../src/views/account.js";

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

const ME = {
  id: 1,
  email: "owner@a.test",
  emailVerifiedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  pendingEmail: null as string | null,
  pendingEmailExpiresAt: null as number | null,
};

const CTX = {
  path: "/account",
  segments: ["account"],
  params: {},
  query: new URLSearchParams(),
};

describe("friendlyAccountError", () => {
  it("rounds the lockout up to whole minutes and copes with a missing retryAfterSec", () => {
    const base = { ok: false as const, status: 423, code: "locked", message: "account temporarily locked" };
    expect(friendlyAccountError({ ...base, retryAfterSec: 30 })).toBe(
      "Zu viele Fehlversuche. Bitte in 1 Min erneut versuchen.",
    );
    expect(friendlyAccountError(base)).toBe("Zu viele Fehlversuche. Bitte später erneut versuchen.");
  });

  it("falls back to the backend message for unknown codes", () => {
    expect(
      friendlyAccountError({ ok: false, status: 500, code: "internal", message: "kaputt" }),
    ).toBe("Fehler: kaputt");
  });
});

describe("renderAccount", () => {
  afterEach(() => _setApiClientForTests(null));

  it("renders the current email + verified date", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME)) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    expect(root.textContent).toContain("owner@a.test");
    expect(root.textContent).toContain("Bestätigt am");
  });

  it("shows the pending-email banner when one is in flight", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ ...ME, pendingEmail: "neu@a.test", pendingEmailExpiresAt: 99 }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    expect(root.textContent).toContain("Änderung auf neu@a.test angefragt");
  });

  it("PATCHes new_email + current_password and shows success", async () => {
    const calls: Array<{ method: string; body: string }> = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        calls.push({
          method,
          body: ((init as RequestInit | undefined)?.body as string) ?? "",
        });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    (root.querySelector("#acc-new-email") as HTMLInputElement).value = "next@a.test";
    (root.querySelector("#acc-email-current-pw") as HTMLInputElement).value = "verysecret1";
    const emailForm = root.querySelector("form")!;
    emailForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(JSON.parse(calls[0].body)).toEqual({
      current_password: "verysecret1",
      new_email: "next@a.test",
    });
    expect(root.textContent).toContain("Bestätigungs-Mail an die neue Adresse unterwegs");
  });

  it("surfaces bad-credentials on email change", async () => {
    let patchCount = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        patchCount += 1;
        return jsonResponse({ error: "bad-credentials", message: "x" }, 403);
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    (root.querySelector("#acc-new-email") as HTMLInputElement).value = "next@a.test";
    (root.querySelector("#acc-email-current-pw") as HTMLInputElement).value = "wrongPw01";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(patchCount).toBe(1);
    expect(root.textContent).toContain("Aktuelles Passwort falsch.");
  });

  it("explains a 423 lockout in German with the remaining minutes (all three forms)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (_input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        return jsonResponse(
          { error: "locked", message: "account temporarily locked", retryAfterSec: 840 },
          423,
        );
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    const forms = root.querySelectorAll("form");

    (root.querySelector("#acc-new-email") as HTMLInputElement).value = "next@a.test";
    (root.querySelector("#acc-email-current-pw") as HTMLInputElement).value = "wrongPw01";
    forms[0].dispatchEvent(new Event("submit", { cancelable: true }));
    (root.querySelector("#acc-current-pw") as HTMLInputElement).value = "wrongPw01";
    (root.querySelector("#acc-new-pw") as HTMLInputElement).value = "newpassword2";
    forms[1].dispatchEvent(new Event("submit", { cancelable: true }));
    (root.querySelector("#acc-confirm") as HTMLInputElement).value = "LÖSCHEN";
    (root.querySelector("#acc-delete-pw") as HTMLInputElement).value = "wrongPw01";
    forms[2].dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    const statuses = Array.from(root.querySelectorAll('[role="status"]')).map(
      (el) => el.textContent ?? "",
    );
    const lockMessages = statuses.filter((t) => t.includes("14 Min"));
    expect(lockMessages, "every form must show the German lockout copy").toHaveLength(3);
    expect(root.textContent).not.toContain("account temporarily locked");
  });

  it("password change navigates to /login on success (sessions revoked)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    (root.querySelector("#acc-current-pw") as HTMLInputElement).value = "verysecret1";
    (root.querySelector("#acc-new-pw") as HTMLInputElement).value = "newpassword2";
    // Form #2 is the password change form.
    const forms = root.querySelectorAll("form");
    forms[1].dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("password change rejects <8-char new password without network", async () => {
    let patchCalled = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        patchCalled = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    (root.querySelector("#acc-current-pw") as HTMLInputElement).value = "verysecret1";
    (root.querySelector("#acc-new-pw") as HTMLInputElement).value = "short";
    const forms = root.querySelectorAll("form");
    forms[1].dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(patchCalled).toBe(false);
    expect(root.textContent).toContain("mindestens 8 Zeichen");
  });

  it("delete requires the exact LÖSCHEN confirm — typo blocks the DELETE", async () => {
    let deleteCalled = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        deleteCalled = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    const forms = root.querySelectorAll("form");
    (root.querySelector("#acc-confirm") as HTMLInputElement).value = "loschen"; // lowercase typo
    (root.querySelector("#acc-delete-pw") as HTMLInputElement).value = "verysecret1";
    forms[2].dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(deleteCalled).toBe(false);
    expect(root.textContent).toContain("Bitte exakt das Wort LÖSCHEN eingeben");
  });

  it("delete with correct confirm navigates to /login on 204", async () => {
    let deleteCalled = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse(ME);
        deleteCalled = true;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    const forms = root.querySelectorAll("form");
    (root.querySelector("#acc-confirm") as HTMLInputElement).value = "LÖSCHEN";
    (root.querySelector("#acc-delete-pw") as HTMLInputElement).value = "verysecret1";
    forms[2].dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(deleteCalled).toBe(true);
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
    const cleanup = renderAccount(root, CTX);
    await flush();
    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });

  it("401 on initial GET → /login redirect", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAccount(root, CTX);
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });
});
