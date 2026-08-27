import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execPublicScript } from "./helpers/exec-public-script";

// feedback-fab.js is loaded by both the German and the English marketing
// pages, so its copy must follow <html lang> like help-overlay.js does —
// and because it declares aria-modal, Tab must stay confined to the dialog
// (review 2026-08).

async function mountFab(lang: "de" | "en"): Promise<HTMLElement> {
  document.documentElement.lang = lang;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  execPublicScript("feedback-fab.js");
  await vi.waitFor(() => {
    expect(document.getElementById("feedback-fab")).not.toBeNull();
  });
  return document.getElementById("feedback-fab") as HTMLElement;
}

function openModal(fab: HTMLElement): HTMLElement {
  fab.click();
  const modal = document.getElementById("feedback-modal");
  expect(modal).not.toBeNull();
  return modal as HTMLElement;
}

function pressTab(shiftKey: boolean): void {
  document.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.lang = "de";
});

describe("feedback FAB language", () => {
  it("renders German copy on German pages", async () => {
    const fab = await mountFab("de");
    expect(fab.getAttribute("aria-label")).toBe("Feedback geben");
    const modal = openModal(fab);
    expect(modal.querySelector("h2")?.textContent).toBe("Feedback geben");
    expect(
      modal.querySelector(".feedback-modal-btn-secondary")?.textContent,
    ).toBe("Abbrechen");
    expect(modal.querySelector(".feedback-modal-btn-primary")?.textContent).toBe(
      "Senden",
    );
  });

  it("renders English copy on English pages", async () => {
    const fab = await mountFab("en");
    expect(fab.getAttribute("aria-label")).toBe("Give feedback");
    const modal = openModal(fab);
    expect(modal.querySelector("h2")?.textContent).toBe("Give feedback");
    expect(
      modal.querySelector(".feedback-modal-btn-secondary")?.textContent,
    ).toBe("Cancel");
    expect(modal.querySelector(".feedback-modal-btn-primary")?.textContent).toBe(
      "Send",
    );
    expect(modal.querySelector("textarea")?.placeholder).toBe(
      "Write us a few sentences — we'll reply by email.",
    );
  });
});

describe("feedback modal focus trap", () => {
  it("wraps Tab from the last control to the first", async () => {
    const modal = openModal(await mountFab("de"));
    const submit = modal.querySelector<HTMLButtonElement>(
      ".feedback-modal-btn-primary",
    );
    const closeBtn = modal.querySelector<HTMLButtonElement>(
      ".feedback-modal-close",
    );
    submit?.focus();
    pressTab(false);
    expect(document.activeElement).toBe(closeBtn);
  });

  it("wraps Shift+Tab from the first control to the last", async () => {
    const modal = openModal(await mountFab("de"));
    const submit = modal.querySelector<HTMLButtonElement>(
      ".feedback-modal-btn-primary",
    );
    const closeBtn = modal.querySelector<HTMLButtonElement>(
      ".feedback-modal-close",
    );
    closeBtn?.focus();
    pressTab(true);
    expect(document.activeElement).toBe(submit);
  });

  it("pulls focus back into the dialog when it escaped", async () => {
    // jsdom can't focus <body>, so simulate the escape with a real
    // focusable control outside the dialog.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const modal = openModal(await mountFab("de"));
    const closeBtn = modal.querySelector<HTMLButtonElement>(
      ".feedback-modal-close",
    );
    outside.focus();
    pressTab(false);
    expect(document.activeElement).toBe(closeBtn);
  });
});
