import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession } from "./helpers/ui-session.js";

// While streaming, #status is hidden inside the collapsed card
// (#app.compact > #status { display: none }) and the line the helper
// actually sees is #compact-status-text. The ICE grace handler used to
// write only #status, so a collapsed card kept saying "Stream läuft."
// through the whole 10 s "Verbindung instabil" window.
describe("ICE grace status mirrors into the compact bar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows 'instabil' in the compact line during disconnected and restores it on recovery", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    session.track(pc);
    (document.getElementById("remote-video") as HTMLVideoElement).dispatchEvent(new Event("playing"));

    const compact = document.getElementById("compact-status-text")!;
    const status = document.getElementById("status")!;
    expect(compact.textContent).toBe("Stream läuft.");

    pc.fireIceState("disconnected");
    expect(status.textContent).toContain("instabil");
    expect(compact.textContent).toContain("instabil");

    pc.fireIceState("connected");
    expect(status.textContent).toBe("Stream läuft.");
    expect(compact.textContent).toBe("Stream läuft.");
  });
});
