import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAdminUsers } from "../src/views/admin-users.js";
import type { RouteContext } from "../src/router.js";

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const ctx: RouteContext = {
  path: "/admin/users",
  segments: ["admin", "users"],
  params: {},
  query: new URLSearchParams(),
};

const USER = {
  id: 7,
  email: "user@example.com",
  admin: false,
  suspended_at: null,
  email_verified_at: 123,
  created_at: 1,
  device_count: 0,
  last_login_at: null,
};

afterEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

describe("renderAdminUsers", () => {
  it("filter chips are an aria-pressed button group, not a faux tablist", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ items: [USER], next_cursor: null })) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();

    const group = root.querySelector(".admin-users-chips")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBeTruthy();
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>(".admin-users-chip"));
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.getAttribute("role")).toBeNull(); // no role="tab"
      expect(chip.hasAttribute("aria-pressed")).toBe(true);
    }
    // The default "alle" filter is pressed.
    const pressed = chips.filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
  });

  it("the 'alle' filter sends no status param; a specific filter does", async () => {
    const urls: string[] = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input) => {
        urls.push(typeof input === "string" ? input : input.toString());
        return jsonResponse({ items: [USER], next_cursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    expect(urls[0]).not.toContain("status=");

    // Click a non-"alle" chip (the second one) → status param appears.
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>(".admin-users-chip"));
    const specific = chips.find((c) => c.dataset.filter && c.dataset.filter !== "alle")!;
    specific.click();
    await flush();
    expect(urls.some((u) => u.includes(`status=${specific.dataset.filter}`))).toBe(true);
  });

  it("renders the email as a keyboard-reachable link to the detail route", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse({ items: [USER], next_cursor: null })) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    const link = root.querySelector("tbody a") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("user@example.com");
    expect(link.getAttribute("href")).toBe("/dashboard/admin/users/7");
  });
});
