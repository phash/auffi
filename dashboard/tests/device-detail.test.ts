import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderDeviceDetail } from "../src/views/device-detail.js";

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

const SEED = {
  id: "111-222-333",
  alias: "Manuels Laptop",
  autoAccept: true,
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
  online: true,
};

function listOnlyFetch(items: typeof SEED[]): typeof fetch {
  return vi.fn(async () => jsonResponse({ items })) as unknown as typeof fetch;
}

function ctx(id: string): import("../src/router.js").RouteContext {
  return {
    path: "/devices/" + id,
    segments: ["devices", id],
    params: { id },
    query: new URLSearchParams(),
  };
}

describe("renderDeviceDetail", () => {
  afterEach(() => _setApiClientForTests(null));

  it("404-style 'Gerät nicht gefunden' when the id doesn't match any item", async () => {
    _setApiClientForTests({ base: "", fetch: listOnlyFetch([SEED]) });
    const root = makeRoot();
    renderDeviceDetail(root, ctx("999-999-999"));
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toContain(
      "Gerät nicht gefunden",
    );
    expect(root.querySelector('a[href$="/devices"]')).not.toBeNull();
  });

  it("renders alias + id + online state once the list resolves", async () => {
    _setApiClientForTests({ base: "", fetch: listOnlyFetch([SEED]) });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const card = root.querySelector(".card") as HTMLElement;
    expect(card.textContent).toContain("Manuels Laptop");
    expect(card.textContent).toContain("111-222-333");
    expect(card.textContent).toContain("Online");
  });

  it("PATCHes the alias on submit + reflects the new name in the header", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/api/devices")) {
          return jsonResponse({ items: [SEED] });
        }
        calls.push({
          method,
          url,
          body: ((init as RequestInit | undefined)?.body as string) ?? "",
        });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const input = root.querySelector("#dev-alias") as HTMLInputElement;
    input.value = "Neuer Name";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/api/devices/111-222-333");
    expect(JSON.parse(calls[0].body)).toEqual({ alias: "Neuer Name" });
    // The h1 should reflect the new alias.
    expect((root.querySelector("h1") as HTMLElement).textContent).toBe("Neuer Name");
  });

  it("rejects too-short or too-long alias without hitting the network", async () => {
    let patchCalled = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/api/devices")) {
          return jsonResponse({ items: [SEED] });
        }
        patchCalled = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const input = root.querySelector("#dev-alias") as HTMLInputElement;
    input.value = "";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(patchCalled).toBe(false);
    // Status is rendered inside the alias form.
    const statuses = root.querySelectorAll('[role="status"]');
    expect(Array.from(statuses).some((el) => el.textContent?.includes("1–80"))).toBe(true);
  });

  it("PATCHes auto_accept on toggle change + rolls back on error", async () => {
    let firstPatchHasFired = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/api/devices")) {
          return jsonResponse({ items: [SEED] });
        }
        if (method === "PATCH") {
          firstPatchHasFired = true;
          return jsonResponse({ error: "boom", message: "DB down" }, 500);
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const toggle = root.querySelector("#dev-auto-accept") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(firstPatchHasFired).toBe(true);
    // Rolled back to the seed value.
    expect(toggle.checked).toBe(true);
  });

  it("DELETE on the danger button navigates back to /devices on success", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        calls.push({ method, url });
        if (method === "GET") return jsonResponse({ items: [SEED] });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const buttons = Array.from(root.querySelectorAll("button"));
    const deleteBtn = buttons.find((b) => b.textContent === "Gerät entkoppeln") as HTMLButtonElement;
    deleteBtn.click();
    await flush();
    // Confirm in the styled dialog (replaces window.confirm).
    const confirmBtn = document.querySelector(
      "#admin-modal-backdrop .btn.danger",
    ) as HTMLButtonElement;
    confirmBtn.click();
    await flush();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(window.location.pathname).toMatch(/\/dashboard\/devices$/);
  });

  it("DELETE no-ops when the user cancels the confirm prompt", async () => {
    let deleteFired = false;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse({ items: [SEED] });
        deleteFired = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx(SEED.id));
    await flush();
    const buttons = Array.from(root.querySelectorAll("button"));
    const deleteBtn = buttons.find((b) => b.textContent === "Gerät entkoppeln") as HTMLButtonElement;
    deleteBtn.click();
    await flush();
    // Cancel in the styled dialog → no DELETE.
    const cancelBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#admin-modal-backdrop .admin-modal-actions button"),
    ).find((b) => b.textContent === "Abbrechen") as HTMLButtonElement;
    cancelBtn.click();
    await flush();
    expect(deleteFired).toBe(false);
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
    const cleanup = renderDeviceDetail(root, ctx("any"));
    await flush();
    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    release!();
    await flush();
    await flush();
    expect(window.location.pathname, "must not have navigated after unmount").toBe(before);
  });

  it("redirects to /login on 401", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "no session" }, 401),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderDeviceDetail(root, ctx("any"));
    await flush();
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });
});
