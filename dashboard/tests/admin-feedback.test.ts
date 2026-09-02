import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { renderAdminFeedback } from "../src/views/admin-feedback.js";
import type { RouteContext } from "../src/router.js";

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

function ctx(): RouteContext {
  return {
    path: "/admin/feedback",
    segments: ["admin", "feedback"],
    params: {},
    query: new URLSearchParams(),
  };
}

function feedbackItem(id: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    accountId: 7,
    accountEmail: `user${id}@example.com`,
    source: "dashboard",
    category: "bug",
    rating: 4,
    body: `Feedback #${id}`,
    userAgentHint: null,
    createdAt: 1_700_000_000_000,
    resolvedAt: null,
    replyBody: null,
    repliedAt: null,
    repliedBy: null,
    replySentAt: null,
    ...over,
  };
}

function findButton(root: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

afterEach(() => _setApiClientForTests(null));

describe("renderAdminFeedback — card meta", () => {
  it("shows the browser/OS hint so a bug report can be placed", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({
          items: [feedbackItem(1, { userAgentHint: "Firefox/Linux" }), feedbackItem(2)],
          nextCursor: null,
        }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const cards = root.querySelectorAll(".feedback-admin-card");
    expect(cards[0].querySelector(".feedback-admin-meta")!.textContent).toContain("Firefox/Linux");
    // A null hint (sharer / stripped UA) renders no empty chip.
    expect(cards[1].querySelector(".feedback-admin-meta")!.textContent).not.toContain("null");
  });
});

describe("renderAdminFeedback — cursor pagination", () => {
  it("hides 'Mehr laden' when the first page is the last page", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ items: [feedbackItem(1)], nextCursor: null }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const more = findButton(root, "Mehr laden");
    expect(more).toBeDefined();
    expect(more.style.display).toBe("none");
  });

  it("shows 'Mehr laden' when nextCursor is set and appends the next page on click", async () => {
    const urls: string[] = [];
    let call = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input: unknown) => {
        urls.push(String(input));
        call += 1;
        if (call === 1) {
          return jsonResponse({ items: [feedbackItem(1)], nextCursor: 55 });
        }
        return jsonResponse({ items: [feedbackItem(2)], nextCursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const more = findButton(root, "Mehr laden");
    expect(more.style.display).not.toBe("none");

    more.click();
    await flush();
    expect(urls[1]).toContain("cursor=55");
    const cards = root.querySelectorAll(".feedback-admin-card");
    expect(cards.length).toBe(2);
    expect(cards[1].textContent).toContain("Feedback #2");
    // Last page reached — button hides again.
    expect(more.style.display).toBe("none");
  });

  it("keeps the load-more error visible and leaves a retry path", async () => {
    let call = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse({ items: [feedbackItem(1)], nextCursor: 55 });
        }
        if (call === 2) {
          return jsonResponse({ error: "internal", message: "kaputt" }, 500);
        }
        return jsonResponse({ items: [feedbackItem(2)], nextCursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const more = findButton(root, "Mehr laden");
    more.click();
    await flush();

    const status = root.querySelector(".error") as HTMLElement;
    expect(status).not.toBeNull();
    expect(status.textContent).toContain("kaputt");
    // Retry path: button stays visible and clickable.
    expect(more.style.display).not.toBe("none");
    expect(more.disabled).toBe(false);

    more.click();
    await flush();
    expect(root.querySelectorAll(".feedback-admin-card").length).toBe(2);
  });
});

describe("renderAdminFeedback — lifecycle + error surfaces", () => {
  afterEach(() => vi.useRealTimers());

  it("does not reload the list after unmount when a failed-mail reply armed the delayed refresh", async () => {
    vi.useFakeTimers();
    let calls = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input: unknown) => {
        calls += 1;
        if (String(input).includes("/reply")) {
          return jsonResponse({ ok: true, replyAt: 1, sentAt: null, sendError: "smtp down" });
        }
        return jsonResponse({ items: [feedbackItem(1)], nextCursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    const cleanup = renderAdminFeedback(root, ctx());
    await vi.advanceTimersByTimeAsync(0);
    findButton(root, "Antworten").click();
    (root.querySelector("textarea") as HTMLTextAreaElement).value = "Danke!";
    findButton(root, "Senden").click();
    await vi.advanceTimersByTimeAsync(0);
    const afterReply = calls;
    expect(root.textContent).toContain("Mail-Versand fehlgeschlagen");

    expect(typeof cleanup, "renderer must return a cleanup for the router").toBe("function");
    (cleanup as () => void)();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls, "no list reload may fire after unmount").toBe(afterReply);
  });

  it("surfaces a failed 'Erledigen' inline instead of via window.alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return jsonResponse({ error: "internal", message: "kaputt" }, 500);
        }
        return jsonResponse({ items: [feedbackItem(1)], nextCursor: null });
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    findButton(root, "Erledigen").click();
    await flush();
    expect(alertSpy).not.toHaveBeenCalled();
    const card = root.querySelector(".feedback-admin-card") as HTMLElement;
    const err = card.querySelector('[role="alert"]') as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("kaputt");
    alertSpy.mockRestore();
  });
});

describe("renderAdminFeedback — tab-race guard", () => {
  it("resets the 'Mehr laden' button when a tab switch supersedes an in-flight load-more", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    let calls = 0;
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            jsonResponse({ items: [feedbackItem(1)], nextCursor: 55 }),
          );
        }
        return new Promise<Response>((resolve) => resolvers.push(resolve));
      }) as unknown as typeof fetch,
    });
    const root = makeRoot();
    renderAdminFeedback(root, ctx());
    await flush();
    const more = findButton(root, "Mehr laden");
    more.click(); // load-more in flight (never resolves before the switch)
    const alleTab = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".feedback-admin-tab"),
    ).find((b) => b.textContent === "Alle")!;
    alleTab.click(); // supersedes the load-more
    resolvers[1](jsonResponse({ items: [feedbackItem(3)], nextCursor: 77 }));
    await flush();
    // The button is usable again for the new tab — not stuck on "Lädt …".
    expect(more.disabled).toBe(false);
    expect(more.textContent).toBe("Mehr laden");
    expect(more.style.display).not.toBe("none");
  });

  it("discards a stale tab response that lands after a newer tab switch", async () => {
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
    renderAdminFeedback(root, ctx()); // request 1 ("open") in flight
    const alleTab = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".feedback-admin-tab"),
    ).find((b) => b.textContent === "Alle")!;
    alleTab.click(); // request 2 ("all") in flight

    expect(urls[0]).toContain("status=open");
    expect(urls[1]).toContain("status=all");

    // The newer request resolves first …
    resolvers[1](jsonResponse({ items: [feedbackItem(2)], nextCursor: null }));
    await flush();
    // … then the stale "open" response lands late and must be discarded.
    resolvers[0](jsonResponse({ items: [feedbackItem(1)], nextCursor: null }));
    await flush();

    const cards = root.querySelectorAll(".feedback-admin-card");
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain("Feedback #2");
  });
});
