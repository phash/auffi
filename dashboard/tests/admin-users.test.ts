import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests, type AdminUserListItem } from "../src/api.js";
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
  it("does not navigate away after unmount when an in-flight request 401s", async () => {
    // Cancelling the debounce is not enough: a request already dispatched can
    // still resolve, and its 401 branch calls navigate("/login") — pulling the
    // admin off whichever page they opened next.
    let release: null | (() => void) = null;
    const fire = (): void => { if (release) release(); };
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse({ error: "unauthorized" }, 401));
          }),
      ) as unknown as typeof fetch,
    });
    const before = location.pathname;
    const root = makeRoot();
    const cleanup = renderAdminUsers(root, ctx);
    await flush();

    (cleanup as () => void)();
    fire();
    await flush();
    await flush();

    expect(location.pathname, "must not have navigated after unmount").toBe(before);
  });

  it("returns a cleanup that cancels a pending search debounce", async () => {
    // The 300 ms debounce outlived the view: leaving mid-typing let it fire
    // against an unmounted view, and its 401 branch calls navigate("/login")
    // — a global history mutation that yanks the admin off whichever page
    // they had just opened.
    let calls = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        calls += 1;
        return jsonResponse({ items: [USER], next_cursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    const cleanup = renderAdminUsers(root, ctx);
    await flush();
    const afterMount = calls;

    const search = root.querySelector<HTMLInputElement>('input[type="search"], input')!;
    search.value = "someone";
    search.dispatchEvent(new Event("input"));

    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();

    await new Promise((r) => setTimeout(r, 400));
    expect(calls, "no fetch may fire after unmount").toBe(afterMount);
  });

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

  it("re-runs a filter change that arrived while a request was in flight", async () => {
    const urls: string[] = [];
    const resolvers: Array<(r: Response) => void> = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn((input: unknown) => {
        urls.push(String(input));
        return new Promise<Response>((resolve) => resolvers.push(resolve));
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminUsers(root, ctx); // request 1 (initial, "alle") in flight

    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>(".admin-users-chip"));
    const suspended = chips.find((c) => c.dataset.filter === "suspended")!;
    suspended.click(); // filter change while loading — must not be dropped
    await flush();
    expect(urls).toHaveLength(1);

    // The stale "alle" response lands → view must re-fetch with the new
    // filter instead of rendering the old filter's rows under the new chip.
    resolvers[0](jsonResponse({ items: [USER], next_cursor: null }));
    await flush();
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("status=suspended");

    resolvers[1](jsonResponse({ items: [], next_cursor: null }));
    await flush();
    // The table shows the NEW filter's (empty) result, not the stale row.
    expect(root.querySelector("tbody")).toBeNull();
    expect(root.textContent).toContain("Keine Nutzer im gewählten Filter.");
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

// ── filters, search, pagination, error surfaces ─────────────────────

type Page = { items: AdminUserListItem[]; next_cursor: string | null };

/** Records each request URL and answers from `respond` (default: one-row page). */
function stubList(respond: (url: URL) => Response | Promise<Response>): URL[] {
  const urls: URL[] = [];
  _setApiClientForTests({
    base: "",
    fetch: vi.fn(async (input: unknown) => {
      const url = new URL(String(input), "http://x");
      urls.push(url);
      return respond(url);
    }) as unknown as typeof fetch,
  });
  return urls;
}

function page(items: AdminUserListItem[], next_cursor: string | null = null): Response {
  const body: Page = { items, next_cursor };
  return jsonResponse(body);
}

function chip(root: HTMLElement, filter: string): HTMLButtonElement {
  return root.querySelector(`.admin-users-chip[data-filter="${filter}"]`) as HTMLButtonElement;
}

function emails(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("tbody a")).map((a) => a.textContent ?? "");
}

describe("renderAdminUsers — filter chips", () => {
  afterEach(() => _setApiClientForTests(null));

  it("moves aria-pressed to the clicked chip and does not refetch for the active one", async () => {
    const urls = stubList(() => page([USER]));
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    expect(chip(root, "alle").getAttribute("aria-pressed")).toBe("true");

    chip(root, "alle").click();
    await flush();
    expect(urls).toHaveLength(1);

    chip(root, "admin").click();
    await flush();
    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get("status")).toBe("admin");
    expect(chip(root, "admin").getAttribute("aria-pressed")).toBe("true");
    expect(chip(root, "admin").classList.contains("active")).toBe(true);
    expect(chip(root, "alle").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("renderAdminUsers — debounced search", () => {
  afterEach(() => {
    vi.useRealTimers();
    _setApiClientForTests(null);
  });

  it("fires one request 300 ms after the last keystroke with the trimmed query", async () => {
    const urls = stubList((url) => (url.searchParams.get("q") ? page([]) : page([USER])));
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    expect(urls).toHaveLength(1);

    vi.useFakeTimers();
    const input = root.querySelector(".admin-users-search") as HTMLInputElement;
    input.value = "a";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);
    input.value = " ab ";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(299);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await flush();

    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get("q")).toBe("ab");
    expect(urls[1].searchParams.get("cursor")).toBeNull();
    expect(root.textContent).toContain("Keine Nutzer für „ab\".");
  });

  it("skips the request when the trimmed query did not change", async () => {
    const urls = stubList(() => page([USER]));
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();

    vi.useFakeTimers();
    const input = root.querySelector(".admin-users-search") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await flush();
    expect(urls).toHaveLength(1);
  });
});

describe("renderAdminUsers — cursor pagination", () => {
  afterEach(() => _setApiClientForTests(null));

  const SECOND = { ...USER, id: 8, email: "second@example.com" };

  it("'Mehr laden' sends the cursor, appends the next page, and disappears on the last page", async () => {
    let release: () => void = () => undefined;
    const urls = stubList((url) =>
      url.searchParams.get("cursor") === "c1"
        ? new Promise<Response>((resolve) => {
            release = () => resolve(page([SECOND]));
          })
        : page([USER], "c1"),
    );
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    const more = root.querySelector(".admin-users-load-more") as HTMLButtonElement;
    expect(more.textContent).toBe("Mehr laden");

    more.click();
    expect(more.disabled).toBe(true);
    expect(more.textContent).toBe("Lädt …");
    await flush();
    expect(urls[1].searchParams.get("cursor")).toBe("c1");
    expect(urls[1].searchParams.get("limit")).toBe("50");

    release();
    await flush();
    expect(emails(root)).toEqual(["user@example.com", "second@example.com"]);
    expect(root.querySelector(".admin-users-load-more")).toBeNull();
  });

  it("keeps the loaded rows and a retry button when 'Mehr laden' fails", async () => {
    let failNext = true;
    stubList((url) => {
      if (url.searchParams.get("cursor") !== "c1") return page([USER], "c1");
      if (failNext) {
        failNext = false;
        return jsonResponse({ error: "internal", message: "kaputt" }, 500);
      }
      return page([SECOND]);
    });
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    (root.querySelector(".admin-users-load-more") as HTMLButtonElement).click();
    await flush();

    expect(emails(root)).toEqual(["user@example.com"]);
    expect((root.querySelector("table")!.parentElement as HTMLElement).style.display).not.toBe("none");
    expect((root.querySelector(".error") as HTMLElement).textContent).toBe("Fehler: kaputt");
    const retry = root.querySelector(".admin-users-load-more") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Mehr laden");

    retry.click();
    await flush();
    expect(emails(root)).toEqual(["user@example.com", "second@example.com"]);
    expect(root.querySelector(".error")).toBeNull();
  });
});

describe("renderAdminUsers — rows and errors", () => {
  afterEach(() => _setApiClientForTests(null));

  it.each([
    [403, "Du musst Admin sein, um die Nutzerliste zu sehen."],
    [500, "Fehler: kaputt"],
  ])("HTTP %i shows its copy instead of a table", async (status, expected) => {
    stubList(() => jsonResponse({ error: "x", message: "kaputt" }, status));
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    expect((root.querySelector(".error") as HTMLElement).textContent).toBe(expected);
    expect(root.querySelector("table")).toBeNull();
  });

  it("renders status badges, device count and last login per row", async () => {
    stubList(() =>
      page([
        { ...USER, id: 1, email: "plain@x.test", device_count: 3, last_login_at: null },
        {
          ...USER,
          id: 2,
          email: "flags@x.test",
          admin: true,
          suspended_at: 5,
          email_verified_at: null,
          last_login_at: 1_700_000_000_000,
        },
      ]),
    );
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    const rows = Array.from(root.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")),
    );
    expect(rows[0][1].textContent).toBe("Aktiv");
    expect(rows[0][2].textContent).toBe("3");
    expect(rows[0][3].textContent).toBe("—");
    expect(Array.from(rows[1][1].querySelectorAll(".user-badge")).map((b) => b.textContent)).toEqual([
      "Admin",
      "Suspendiert",
      "Unverifiziert",
    ]);
    expect(rows[1][3].textContent).not.toBe("—");
  });

  it("navigates to the detail route when a row (not the link) is clicked", async () => {
    stubList(() => page([USER]));
    window.history.pushState({}, "", "/dashboard/admin/users");
    const root = makeRoot();
    renderAdminUsers(root, ctx);
    await flush();
    (root.querySelector("tbody td:nth-child(3)") as HTMLElement).click();
    expect(window.location.pathname).toBe("/dashboard/admin/users/7");
  });
});
