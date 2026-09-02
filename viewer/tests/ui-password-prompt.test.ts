import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession } from "./helpers/ui-session.js";

function pressEnter(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

describe("unattended password prompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the prompt on needs-password and sends the typed password", async () => {
    const { ws } = await startUiSession();
    ws.fakeMessage({ type: "needs-password" });

    const toast = document.getElementById("pw-prompt-toast")!;
    expect(toast.classList.contains("active")).toBe(true);

    const input = document.getElementById("pw-prompt-input") as HTMLInputElement;
    input.value = "geheim";
    pressEnter(input);
    expect(ws.sentOfType("pw-attempt")).toEqual([{ type: "pw-attempt", password: "geheim" }]);
  });

  // Holding Enter ~500 ms (OS key-repeat) or double-tapping while the
  // argon2 round-trip to the sharer is in flight used to send a second
  // pw-attempt; the backend answers that with a fatal bad-message and the
  // just-authenticated session died with "Unerwartete Antwort vom Server".
  it("Enter key-repeat while the check is in flight sends exactly one pw-attempt", async () => {
    const { ws } = await startUiSession();
    ws.fakeMessage({ type: "needs-password" });

    const input = document.getElementById("pw-prompt-input") as HTMLInputElement;
    input.value = "geheim";
    pressEnter(input);
    pressEnter(input);
    pressEnter(input);
    (document.getElementById("pw-prompt-submit") as HTMLButtonElement).click();

    expect(ws.sentOfType("pw-attempt")).toHaveLength(1);
    expect(document.getElementById("pw-prompt-toast")!.classList.contains("active")).toBe(true);
  });

  // With autoAccept=false the pw-check round-trip includes the remote user
  // walking to the PC and clicking Akzeptieren — the same human step the
  // ad-hoc path grants 60 s (the backend allows 2 min). Arming the 30 s media
  // window here tore the viewer down while that click was still pending.
  it("gives the pw-check round-trip the confirm window, not the media window", async () => {
    vi.useFakeTimers();
    try {
      const { ws } = await startUiSession();
      const { CONNECT_CONFIRM_TIMEOUT_MS, CONNECT_MEDIA_TIMEOUT_MS } = await import("../src/ui.js");
      ws.fakeMessage({ type: "needs-password" });
      const input = document.getElementById("pw-prompt-input") as HTMLInputElement;
      input.value = "geheim";
      pressEnter(input);
      const status = document.getElementById("status")!;

      vi.advanceTimersByTime(CONNECT_MEDIA_TIMEOUT_MS + 1);
      expect(status.textContent).toContain("Passwort wird geprüft");
      expect(document.getElementById("pw-prompt-toast")!.classList.contains("active")).toBe(true);

      vi.advanceTimersByTime(CONNECT_CONFIRM_TIMEOUT_MS - CONNECT_MEDIA_TIMEOUT_MS);
      expect(status.textContent?.toLowerCase()).toContain("bestätigt");
      expect(document.getElementById("pw-prompt-toast")!.classList.contains("active")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wrong-password re-opens the prompt and allows exactly one more attempt", async () => {
    const { ws } = await startUiSession();
    ws.fakeMessage({ type: "needs-password" });
    const input = document.getElementById("pw-prompt-input") as HTMLInputElement;
    input.value = "falsch";
    pressEnter(input);
    ws.fakeMessage({ type: "wrong-password", attemptsLeft: 4 });

    expect(document.getElementById("pw-prompt-message")!.textContent).toContain("4");
    input.value = "richtig";
    pressEnter(input);
    pressEnter(input);
    const attempts = ws.sentOfType("pw-attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].password).toBe("richtig");
  });
});
