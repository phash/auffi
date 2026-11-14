import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import { installFeedbackFab } from "../src/components/feedback-fab.js";

function fab(): HTMLButtonElement {
  return document.getElementById("feedback-fab") as HTMLButtonElement;
}

describe("installFeedbackFab", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts the FAB for a logged-in user and removes it again for an anonymous one", () => {
    installFeedbackFab(true);
    expect(fab()).not.toBeNull();
    installFeedbackFab(false);
    expect(document.getElementById("feedback-fab")).toBeNull();
  });

  it("opens the modal with focus on the textarea and returns focus to the FAB on Escape", () => {
    installFeedbackFab(true);
    fab().focus();
    fab().click();
    const overlay = document.getElementById("feedback-modal")!;
    expect(overlay).not.toBeNull();
    expect(document.activeElement).toBe(overlay.querySelector("textarea"));
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.getElementById("feedback-modal")).toBeNull();
    expect(document.activeElement).toBe(fab());
  });
});

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function openModal(): HTMLElement {
  installFeedbackFab(true);
  fab().click();
  return document.getElementById("feedback-modal")!;
}

function submit(overlay: HTMLElement): void {
  overlay.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}

function statusText(overlay: HTMLElement): string {
  return (overlay.querySelector(".feedback-modal-status") as HTMLElement).textContent ?? "";
}

describe("feedback FAB submit", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => _setApiClientForTests(null));

  it("POSTs the chosen category, rating and trimmed body, then closes with a toast", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const overlay = openModal();
    (overlay.querySelector('[data-rating="2"]') as HTMLButtonElement).click();
    (overlay.querySelector("select") as HTMLSelectElement).value = "feature";
    (overlay.querySelector("textarea") as HTMLTextAreaElement).value = "  Dunkles Design bitte  ";
    submit(overlay);
    await flush();

    expect(calls).toEqual([
      {
        url: "/api/feedback",
        body: { source: "dashboard", category: "feature", rating: 2, body: "Dunkles Design bitte" },
      },
    ]);
    expect(document.getElementById("feedback-modal")).toBeNull();
    expect(document.getElementById("feedback-toast")?.textContent).toBe("Danke fürs Feedback!");
  });

  it("rejects a whitespace-only body without calling the backend", async () => {
    const fetchSpy = vi.fn();
    _setApiClientForTests({ base: "", fetch: fetchSpy as unknown as typeof fetch });
    const overlay = openModal();
    (overlay.querySelector("textarea") as HTMLTextAreaElement).value = "   ";
    submit(overlay);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statusText(overlay)).toBe("Bitte Text eingeben.");
  });

  it.each<[string, number, Record<string, string>, string]>([
    ["expired session", 401, { error: "no-auth", message: "login or device-bearer required" },
      "Sitzung abgelaufen, bitte neu anmelden."],
    ["server error", 500, { error: "internal", message: "internal server error" },
      "Feedback konnte nicht gesendet werden. Bitte später erneut versuchen."],
  ])("shows German copy on %s and re-enables the submit button", async (_name, status, body, copy) => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch,
    });
    const overlay = openModal();
    (overlay.querySelector("textarea") as HTMLTextAreaElement).value = "Text";
    submit(overlay);
    await flush();
    expect(statusText(overlay)).toBe(copy);
    expect((overlay.querySelector('[data-action="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps request()'s German rate-limit copy", async () => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        jsonResponse({ error: "rate-limit", message: "too many" }, 429),
      ) as unknown as typeof fetch,
    });
    const overlay = openModal();
    (overlay.querySelector("textarea") as HTMLTextAreaElement).value = "Text";
    submit(overlay);
    await flush();
    expect(statusText(overlay)).not.toContain("too many");
    expect(statusText(overlay).length).toBeGreaterThan(0);
  });
});
