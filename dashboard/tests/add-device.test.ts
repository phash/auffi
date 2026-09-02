import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAddDevice, renderExpiryText } from "../src/views/add-device.js";

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

describe("renderExpiryText", () => {
  const NOW = 10_000_000_000;

  it("returns 'expired' once the deadline has passed", () => {
    expect(renderExpiryText(NOW - 1, NOW)).toBe("expired");
    expect(renderExpiryText(NOW, NOW)).toBe("expired");
  });

  it("renders M:SS minutes when ≥ 1 min remains", () => {
    expect(renderExpiryText(NOW + 9 * 60_000, NOW)).toBe("Läuft in 9:00 Min ab");
    expect(renderExpiryText(NOW + 9 * 60_000 + 5_000, NOW)).toBe("Läuft in 9:05 Min ab");
  });

  it("zero-pads seconds inside the minute window", () => {
    expect(renderExpiryText(NOW + 1 * 60_000 + 5_000, NOW)).toBe("Läuft in 1:05 Min ab");
  });

  it("renders bare seconds < 1 min with singular/plural", () => {
    expect(renderExpiryText(NOW + 1_000, NOW)).toBe("Läuft in 1 Sekunde ab");
    expect(renderExpiryText(NOW + 30_000, NOW)).toBe("Läuft in 30 Sekunden ab");
  });
});

describe("renderAddDevice", () => {
  afterEach(() => _setApiClientForTests(null));

  beforeEach(() => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({
          code: "ABC-DEF-7K",
          expiresAt: Date.now() + 10 * 60_000,
        }),
      ) as unknown as typeof fetch,
    });
  });

  it("mints + displays the code in a large monospace box", async () => {
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    // The aria-labeled code box is the source of truth.
    const codeBox = root.querySelector('[aria-label="Pairing-Code"]') as HTMLElement;
    expect(codeBox.textContent).toBe("ABC-DEF-7K");
    expect(codeBox.style.fontFamily).toContain("monospace");
  });

  it("shows a countdown that mentions the remaining minutes", async () => {
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const expiryText = root.querySelector('p[role="status"][aria-live="polite"]') as HTMLElement;
    expect(expiryText.textContent).toMatch(/Läuft in \d+:\d{2} Min ab/);
  });

  it("redirects to /login on 401", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
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
    const cleanup = renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });

  it("surfaces the backend message on other errors", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "internal", message: "kaputt" }, 500),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain("kaputt");
  });

  it("shows German copy when the 5/h pairing-code cap answers with Fastify's 429", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse(
          { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded, retry in 1 hour" },
          429,
        ),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const err = (root.querySelector(".error") as HTMLElement).textContent ?? "";
    expect(err).toContain("Zu viele Versuche");
    expect(err).not.toContain("Rate limit exceeded");
  });

  it("renders the expired state immediately when the code is already expired on mount", async () => {
    // Client clock ahead of the server → expiresAt already in the past on
    // the first countdown tick (gh review: TDZ crash on clearInterval).
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ code: "ABC-DEF-7K", expiresAt: Date.now() - 1_000 }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    expect(root.textContent).toContain("Code abgelaufen");
    expect(root.querySelector('a[href$="/devices/new"]')).not.toBeNull();
  });

  it("provides a back-link to /devices", async () => {
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const link = root.querySelector('a[href$="/devices"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain("Geräte-Liste");
  });
});

describe("renderAddDevice — countdown lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    _setApiClientForTests(null);
  });

  it("returns a cleanup that stops the countdown interval on unmount", async () => {
    vi.useFakeTimers();
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ code: "ABC-DEF-7K", expiresAt: Date.now() + 10 * 60_000 }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    const cleanup = renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await vi.advanceTimersByTimeAsync(0);
    // The countdown interval is ticking …
    expect(vi.getTimerCount()).toBe(1);
    // … and the renderer handed the router a cleanup that stops it.
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no countdown when the view unmounted before the mint resolved", async () => {
    // Leaving /devices/new during the POST round-trip ran the cleanup while
    // stopCountdown was still null; the late response then started an
    // interval nobody could ever stop.
    vi.useFakeTimers();
    let release: null | (() => void) = null;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(jsonResponse({ code: "ABC-DEF-7K", expiresAt: Date.now() + 10 * 60_000 }));
          }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    const cleanup = renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    (cleanup as () => void)();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(root.querySelector('[aria-label="Pairing-Code"]')).toBeNull();
  });

  it("starts no interval at all when the code is already expired on mount", async () => {
    vi.useFakeTimers();
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ code: "ABC-DEF-7K", expiresAt: Date.now() - 1 }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAddDevice(root, {
      path: "/devices/new",
      segments: ["devices", "new"],
      params: {},
      query: new URLSearchParams(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain("Code abgelaufen");
    expect(vi.getTimerCount()).toBe(0);
  });
});
