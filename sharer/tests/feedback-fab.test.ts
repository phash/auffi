// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { refreshFeedbackFab } from "../src/feedback-fab.js";

async function mountFab(): Promise<HTMLButtonElement> {
  invokeMock.mockImplementation((cmd: unknown) => {
    if (cmd === "unattended_is_paired") return Promise.resolve("device-1");
    if (cmd === "unattended_is_password_set") return Promise.resolve(true);
    return Promise.resolve(null);
  });
  await refreshFeedbackFab();
  return document.getElementById("auffi-feedback-fab") as HTMLButtonElement;
}

describe("feedback modal (sharer)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    invokeMock.mockReset();
  });

  it("closes on Escape like the other dialogs", async () => {
    const fab = await mountFab();
    fab.click();
    const overlay = document.getElementById("auffi-feedback-modal")!;
    expect(overlay).not.toBeNull();
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.getElementById("auffi-feedback-modal")).toBeNull();
  });

  // Boot and the state-changed event both refresh: each removed the old FAB
  // before its awaits and appended after them, so two overlapping refreshes
  // left two FABs stacked on top of each other.
  it("keeps a single FAB when refreshes overlap", async () => {
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === "unattended_is_paired") return Promise.resolve("device-1");
      if (cmd === "unattended_is_password_set") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    await Promise.all([refreshFeedbackFab(), refreshFeedbackFab(), refreshFeedbackFab()]);
    expect(document.querySelectorAll("#auffi-feedback-fab")).toHaveLength(1);
  });

  it("lets the newest refresh win when the device was unpaired meanwhile", async () => {
    let paired: string | null = "device-1";
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === "unattended_is_paired") return Promise.resolve(paired);
      if (cmd === "unattended_is_password_set") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    const first = refreshFeedbackFab();
    paired = null;
    const second = refreshFeedbackFab();
    await Promise.all([first, second]);
    expect(document.getElementById("auffi-feedback-fab")).toBeNull();
  });

  it("shows German copy instead of a raw error object on a failed send", async () => {
    const fab = await mountFab();
    fab.click();
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === "unattended_submit_feedback"
        ? Promise.reject(new Error("reqwest::Error { kind: Request }"))
        : Promise.resolve(null),
    );
    const area = document.querySelector<HTMLTextAreaElement>("#auffi-feedback-modal textarea")!;
    area.value = "Hallo";
    document
      .querySelector<HTMLFormElement>("#auffi-feedback-modal form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    const status = document.querySelector(".feedback-modal-status")!;
    expect(status.textContent).toBe("Feedback konnte nicht gesendet werden.");

    // Rust already answers with German copy — that is shown as-is.
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === "unattended_submit_feedback"
        ? Promise.reject("Zu viele Feedback-Nachrichten — bitte in einer Minute erneut versuchen.")
        : Promise.resolve(null),
    );
    document
      .querySelector<HTMLFormElement>("#auffi-feedback-modal form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(status.textContent).toContain("Zu viele Feedback-Nachrichten");
  });

  it("returns focus to the FAB when the modal closes", async () => {
    const fab = await mountFab();
    fab.focus();
    fab.click();
    const closeBtn = document.querySelector<HTMLButtonElement>(".feedback-modal-close")!;
    closeBtn.click();
    expect(document.getElementById("auffi-feedback-modal")).toBeNull();
    expect(document.activeElement).toBe(fab);
  });
});
