import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderConnectionLog } from "../src/views/connection-log.js";
import { formatBytes, formatDuration } from "../src/format.js";

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

function ctx(id: string): import("../src/router.js").RouteContext {
  return {
    path: "/devices/" + id + "/log",
    segments: ["devices", id, "log"],
    params: { id },
    query: new URLSearchParams(),
  };
}

describe("format helpers", () => {
  it("formatBytes: '—' for 0, KB / MB scaling", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("formatDuration: '—' on null end, mm:ss vs hh:mm:ss", () => {
    const start = 1_700_000_000_000;
    expect(formatDuration(start, null)).toBe("—");
    expect(formatDuration(start, start + 5_000)).toBe("0:05 Min");
    expect(formatDuration(start, start + 65 * 1000)).toBe("1:05 Min");
    expect(formatDuration(start, start + (60 * 60 + 5 * 60 + 30) * 1000)).toBe(
      "1:05:30 Std",
    );
  });
});

describe("renderConnectionLog", () => {
  afterEach(() => _setApiClientForTests(null));

  it("renders the empty-state message when items: []", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ items: [], nextCursor: null, maxLimit: 100 }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderConnectionLog(root, ctx("111-222-333"));
    await flush();
    expect(root.textContent).toContain("Noch keine Verbindungen aufgezeichnet");
  });

  it("renders one li per row with start time + duration + bytes", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 2,
              deviceId: "111-222-333",
              startedAt: 1_700_000_000_000,
              endedAt: 1_700_000_010_000,
              viewerIpPrefix: "84.xxx",
              connectionType: "relay" as const,
              bytesRelayed: 5 * 1024 * 1024,
            },
            {
              id: 1,
              deviceId: "111-222-333",
              startedAt: 1_700_000_100_000,
              endedAt: 1_700_000_103_000,
              viewerIpPrefix: "84.xxx",
              connectionType: "p2p" as const,
              bytesRelayed: 0,
            },
          ],
          nextCursor: null,
          maxLimit: 100,
        }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderConnectionLog(root, ctx("111-222-333"));
    await flush();
    const items = root.querySelectorAll("li");
    expect(items.length).toBe(2);
    // p2p row shows "—" bytes (since bytes_relayed = 0).
    expect(items[1].textContent).toContain("P2P");
    expect(items[1].textContent).toContain("—");
    // relay row shows the actual bytes.
    expect(items[0].textContent).toContain("Relay");
    expect(items[0].textContent).toContain("5.0 MB");
  });

  it("shows a 'Mehr laden' button when nextCursor is non-null, and fetches it on click", async () => {
    let callIdx = 0;
    const captured: string[] = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        captured.push(url);
        callIdx += 1;
        if (callIdx === 1) {
          return jsonResponse({
            items: [
              {
                id: 30,
                deviceId: "111-222-333",
                startedAt: 1,
                endedAt: 2,
                viewerIpPrefix: "84.xxx",
                connectionType: "p2p" as const,
                bytesRelayed: 0,
              },
            ],
            nextCursor: 30,
            maxLimit: 100,
          });
        }
        return jsonResponse({
          items: [
            {
              id: 20,
              deviceId: "111-222-333",
              startedAt: 1,
              endedAt: 2,
              viewerIpPrefix: "84.xxx",
              connectionType: "p2p" as const,
              bytesRelayed: 0,
            },
          ],
          nextCursor: null,
          maxLimit: 100,
        });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderConnectionLog(root, ctx("111-222-333"));
    await flush();
    const more = root.querySelector("button.primary") as HTMLButtonElement;
    expect(more.style.display).not.toBe("none");
    more.click();
    await flush();
    expect(captured[1]).toContain("cursor=30");
    expect(root.querySelectorAll("li").length).toBe(2);
    // After the last page the "Mehr laden" button hides.
    expect(more.style.display).toBe("none");
  });

  it("redirects to /login on 401", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderConnectionLog(root, ctx("111-222-333"));
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("surfaces a 403 (forbidden — cross-account) as an error", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "forbidden", message: "not your device" }, 403),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderConnectionLog(root, ctx("111-222-333"));
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "not your device",
    );
  });

  it("guards against missing device id in the route", () => {
    const root = makeRoot();
    renderConnectionLog(root, {
      path: "/devices//log",
      segments: ["devices", "", "log"],
      params: { id: "" },
      query: new URLSearchParams(),
    });
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "Geräte-ID fehlt",
    );
  });
});
