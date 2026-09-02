import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _setApiClientForTests,
  deleteDevice,
  login,
  logout,
  signup,
  verifyEmail,
} from "../src/api.js";

function mockFetch(impl: typeof fetch): typeof fetch {
  return impl;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("api request shape", () => {
  let calls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    _setApiClientForTests({
      base: "https://backend.test",
      fetch: mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init: init ?? {} });
        return jsonResponse({ ok: true });
      }),
    });
  });

  afterEach(() => {
    _setApiClientForTests(null);
  });

  it("prefixes the base URL and sends credentials:include", async () => {
    await signup("a@a.test", "verysecret1");
    expect(calls[0].url).toBe("https://backend.test/api/auth/signup");
    expect((calls[0].init as RequestInit).credentials).toBe("include");
  });

  it("serialises JSON bodies with content-type: application/json", async () => {
    await login("a@a.test", "verysecret1");
    const init = calls[0].init;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@a.test",
      password: "verysecret1",
    });
  });

  it("GET verify uses the right URL-encoded path and no body", async () => {
    await verifyEmail("abc/def 7K");
    expect(calls[0].url).toBe(
      "https://backend.test/api/auth/verify/abc%2Fdef%207K",
    );
    expect((calls[0].init as RequestInit).method).toBe("GET");
  });

  it("logout sends POST with no body", async () => {
    await logout();
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBeUndefined();
  });
});

describe("api response handling", () => {
  afterEach(() => {
    _setApiClientForTests(null);
  });

  it("wraps a 200 JSON body in ok:true", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    const res = await signup("a@a.test", "verysecret1");
    expect(res).toEqual({ ok: true, data: { ok: true } });
  });

  it("decodes a 4xx body into {ok:false, code, message}", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: "email-taken", message: "email already registered" },
          { status: 409 },
        ),
      ) as unknown as typeof fetch,
    });
    const res = await signup("a@a.test", "verysecret1");
    expect(res).toEqual({
      ok: false,
      status: 409,
      code: "email-taken",
      message: "email already registered",
    });
  });

  it("synthesises a network-error result on fetch throw", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const res = await login("a@a.test", "verysecret1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(0);
    expect(res.code).toBe("network-error");
    // Fixed friendly German copy — the raw exception must NOT leak through.
    expect(res.message).toContain("Netzwerkfehler");
    expect(res.message).not.toContain("ECONNREFUSED");
  });

  it("normalises @fastify/rate-limit's 429 into code rate-limit with German copy", async () => {
    // The backend registers the plugin with its default errorResponseBuilder,
    // so the wire body is { statusCode, error: "Too Many Requests", message:
    // "Rate limit exceeded, retry in 1 minute" } — never error:"rate-limit".
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            statusCode: 429,
            error: "Too Many Requests",
            message: "Rate limit exceeded, retry in 1 minute",
          },
          { status: 429 },
        ),
      ) as unknown as typeof fetch,
    });
    const res = await login("a@a.test", "verysecret1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(429);
    expect(res.code).toBe("rate-limit");
    expect(res.message).toBe("Zu viele Versuche. Bitte später erneut versuchen.");
  });

  it("carries retryAfterSec from a 423 locked body", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: "locked", message: "account temporarily locked", retryAfterSec: 840 },
          { status: 423 },
        ),
      ) as unknown as typeof fetch,
    });
    const res = await login("a@a.test", "verysecret1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("locked");
    expect(res.retryAfterSec).toBe(840);
  });

  it("falls back to http-error when the body isn't JSON-shaped", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        new Response("<html>500 oops</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      ) as unknown as typeof fetch,
    });
    const res = await login("a@a.test", "verysecret1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(500);
    expect(res.code).toBe("http-error");
    expect(res.message).toBe("HTTP 500");
  });

  it("types the 204 DELETE helpers as bodiless — data is undefined, not {ok:true}", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });
    const res = await deleteDevice("111-222-333");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // With the corrected signature `res.data` is `void`; reading a property
    // off it must not type-check, so this is the only thing a caller may do.
    const body: void = res.data;
    expect(body).toBeUndefined();
  });

  it("handles an empty 2xx body as ok:true (logout returns 204)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        // RFC says 204 has no body; use null body explicitly so the
        // Response constructor doesn't reject the empty string.
        new Response(null, { status: 204 }),
      ) as unknown as typeof fetch,
    });
    const res = await logout();
    expect(res.ok).toBe(true);
  });
});
