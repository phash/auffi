import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { mountLogoutButton } from "../src/logout-button.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeContainer(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const el = document.createElement("div");
  el.className = "topbar-meta";
  document.body.appendChild(el);
  return el;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Wait one macro-task tick so async click handlers fully resolve. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── tests ─────────────────────────────────────────────────────────────

describe("mountLogoutButton", () => {
  afterEach(() => _setApiClientForTests(null));

  it("renders a button with text 'Abmelden' and class 'topbar-logout-btn'", () => {
    const container = makeContainer();
    const btn = mountLogoutButton(container);
    expect(btn.textContent).toBe("Abmelden");
    expect(btn.className).toBe("topbar-logout-btn");
    expect(btn.type).toBe("button");
  });

  it("appends the button directly to the container when no .topbar-actions zone is present", () => {
    const container = makeContainer();
    mountLogoutButton(container);
    expect(container.querySelector(".topbar-logout-btn")).not.toBeNull();
  });

  it("appends the button into an existing .topbar-actions right-zone when present", () => {
    const container = makeContainer();
    const actions = document.createElement("div");
    actions.className = "topbar-actions";
    container.appendChild(actions);

    mountLogoutButton(container);

    // Button lands inside the right-zone, not loose in the container.
    expect(actions.querySelector(".topbar-logout-btn")).not.toBeNull();
    expect(container.children).toHaveLength(1);
  });

  it("calls POST /api/auth/logout and then navigates to /login on success", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    const container = makeContainer();
    const btn = mountLogoutButton(container);

    btn.click();
    await flush();

    // Should have navigated to /dashboard/login (router prefixes BASE_PATH).
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("navigates to /login even when the logout API rejects (network error)", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const container = makeContainer();
    const btn = mountLogoutButton(container);

    btn.click();
    await flush();

    // Should still navigate to /login despite the API error.
    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });

  it("navigates to /login even when the logout API returns 4xx", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "unauthorized", message: "x" }, 401),
      ) as unknown as typeof fetch,
    });
    const container = makeContainer();
    const btn = mountLogoutButton(container);

    btn.click();
    await flush();

    expect(window.location.pathname).toMatch(/\/dashboard\/login$/);
  });
});
