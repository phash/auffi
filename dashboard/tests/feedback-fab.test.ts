import { describe, it, expect, beforeEach } from "vitest";
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
