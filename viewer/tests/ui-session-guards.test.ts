import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildUiTestDOM } from "./helpers/ui-dom.js";

function fileDragEvent(type: string, types: string[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  // jsdom cannot construct a DataTransfer; the handler only reads `types`.
  Object.defineProperty(ev, "dataTransfer", { value: { types } });
  return ev;
}

async function bindWithFailingFetch(): Promise<void> {
  const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
  vi.stubGlobal("fetch", fakeFetch);
  const { bindUI } = await import("../src/ui.js");
  bindUI("ws://localhost:8080");
}

describe("file-drag guards", () => {
  beforeEach(() => {
    buildUiTestDOM();
    vi.clearAllMocks();
  });

  // Dropping a file 20px outside the video wrapper (toolbar, status bar,
  // page background) triggers the browser default of navigating to the
  // dropped file — unloading the page and killing a live session.
  it("prevents the default for file drags anywhere on the document", async () => {
    await bindWithFailingFetch();

    const over = fileDragEvent("dragover", ["Files"]);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = fileDragEvent("drop", ["Files"]);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    vi.unstubAllGlobals();
  });

  it("leaves text drags alone (dragging the code into the input keeps working)", async () => {
    await bindWithFailingFetch();

    const over = fileDragEvent("dragover", ["text/plain"]);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);

    vi.unstubAllGlobals();
  });

  it("prevents the default on the video wrapper even before the file channel is ready", async () => {
    await bindWithFailingFetch();
    const wrapper = document.getElementById("video-wrapper")!;

    // fileManager is null here (no session) — the drop must still not
    // navigate; it is simply not forwarded anywhere.
    const drop = fileDragEvent("drop", ["Files"]);
    wrapper.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("teardown with the password prompt open", () => {
  beforeEach(() => {
    buildUiTestDOM();
    vi.clearAllMocks();
  });

  it("closes the pw modal when the user cancels the connect", async () => {
    await bindWithFailingFetch();

    const pwToast = document.getElementById("pw-prompt-toast")!;
    const pwInput = document.getElementById("pw-prompt-input") as HTMLInputElement;
    // Simulate the needs-password state (modal shown mid-connect).
    pwToast.classList.add("active");
    pwInput.value = "tipp-tipp";

    (document.getElementById("cancel-connect") as HTMLButtonElement).click();

    expect(pwToast.classList.contains("active")).toBe(false);
    expect(pwInput.value).toBe("");

    vi.unstubAllGlobals();
  });

  it("closes the pw modal on a manual disconnect teardown", async () => {
    await bindWithFailingFetch();

    const pwToast = document.getElementById("pw-prompt-toast")!;
    pwToast.classList.add("active");

    (document.getElementById("disconnect") as HTMLButtonElement).click();

    expect(pwToast.classList.contains("active")).toBe(false);

    vi.unstubAllGlobals();
  });
});
