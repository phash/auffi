import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderDevices } from "../src/views/devices.js";

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

describe("renderDevices", () => {
  afterEach(() => _setApiClientForTests(null));

  it("shows a loading state until the response lands", () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(
        () => new Promise(() => undefined) as Promise<Response>,
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    expect((root.querySelector(".loading") as HTMLElement).textContent).toBe(
      "Lade Geräte …",
    );
  });

  it("renders an empty state when items: [] arrives", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const card = root.querySelector(".card") as HTMLElement;
    expect(card.textContent).toContain("Noch keine Geräte gepairt");
    expect(card.querySelector("ul")).toBeNull();
    // Header still shows the "+ Neues Gerät" CTA on empty state.
    expect(card.querySelector('a[href$="/devices/new"]')).not.toBeNull();
  });

  it("renders one li per device with alias + id + online indicator", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: "111-222-333",
              alias: "Manuels Laptop",
              autoAccept: true,
              createdAt: 1_700_000_000_000,
              lastSeenAt: Date.now() - 5 * 60_000,
              online: true,
            },
            {
              id: "444-555-666",
              alias: "Büro-PC",
              autoAccept: false,
              createdAt: 1_700_000_000_000,
              lastSeenAt: null,
              online: false,
            },
          ],
        }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const items = root.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("Manuels Laptop");
    expect(items[0].textContent).toContain("111-222-333");
    expect(items[0].textContent).toContain("Online");
    expect(items[1].textContent).toContain("Büro-PC");
    expect(items[1].textContent).toContain("Offline");
    expect(items[1].textContent).toContain("Noch nie verbunden");
    // Alias link routes to device detail.
    const alias = items[0].querySelector("a") as HTMLAnchorElement;
    expect(alias.getAttribute("href")).toBe("/dashboard/devices/111-222-333");
  });

  it("redirects to /login on 401 (cookie expired)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("does not navigate away after unmount when an in-flight request 401s", async () => {
    // The router's per-render container only isolates DOM writes; the 401
    // branch's navigate("/login") is a global history mutation that must not
    // fire for a view the user has already left.
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
    const cleanup = renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });

  it("shows the backend message on other failure codes (500)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        new Response("<html>oops</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDevices(root, {
      path: "/devices",
      segments: ["devices"],
      params: {},
      query: new URLSearchParams(),
    });
    await flush();
    const status = root.querySelector(".error") as HTMLElement;
    expect(status.textContent).toContain("HTTP 500");
  });
});
