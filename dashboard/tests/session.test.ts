import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import {
  _resetSessionForTests,
  isAdmin,
  isLoggedIn,
  onSessionChange,
  refreshSession,
  type SessionState,
} from "../src/session.js";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ME_ADMIN = {
  id: 1,
  email: "admin@example.com",
  emailVerifiedAt: 1,
  createdAt: 1,
  admin: true,
  pendingEmail: null,
  pendingEmailExpiresAt: null,
};

const ME_USER = { ...ME_ADMIN, admin: false };

afterEach(() => {
  _setApiClientForTests(null);
  _resetSessionForTests();
});

describe("session", () => {
  it("starts anonymous (logged-out, non-admin)", () => {
    expect(isLoggedIn()).toBe(false);
    expect(isAdmin()).toBe(false);
  });

  it("refreshSession caches a logged-in admin probe", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME_ADMIN)) as unknown as typeof fetch,
    });
    const state = await refreshSession();
    expect(state).toEqual({ loggedIn: true, admin: true });
    expect(isLoggedIn()).toBe(true);
    expect(isAdmin()).toBe(true);
  });

  it("refreshSession caches a logged-in non-admin probe", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME_USER)) as unknown as typeof fetch,
    });
    expect(await refreshSession()).toEqual({ loggedIn: true, admin: false });
  });

  it("collapses 401 and network errors into anonymous", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    expect(await refreshSession()).toEqual({ loggedIn: false, admin: false });

    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await refreshSession()).toEqual({ loggedIn: false, admin: false });
  });

  it("notifies listeners only when the probed state actually changes", async () => {
    const seen: SessionState[] = [];
    onSessionChange((s) => seen.push(s));

    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    await refreshSession(); // anonymous → anonymous: no event
    expect(seen).toEqual([]);

    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME_ADMIN)) as unknown as typeof fetch,
    });
    await refreshSession(); // → logged-in admin: one event
    await refreshSession(); // unchanged: no second event
    expect(seen).toEqual([{ loggedIn: true, admin: true }]);
  });

  it("fires on logout (logged-in → anonymous)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME_ADMIN)) as unknown as typeof fetch,
    });
    await refreshSession();

    const seen: SessionState[] = [];
    onSessionChange((s) => seen.push(s));
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    await refreshSession();
    expect(seen).toEqual([{ loggedIn: false, admin: false }]);
  });

  it("unsubscribe stops further notifications", async () => {
    const seen: SessionState[] = [];
    const off = onSessionChange((s) => seen.push(s));
    off();
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(ME_ADMIN)) as unknown as typeof fetch,
    });
    await refreshSession();
    expect(seen).toEqual([]);
  });
});
