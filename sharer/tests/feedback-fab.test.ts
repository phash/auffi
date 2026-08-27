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
