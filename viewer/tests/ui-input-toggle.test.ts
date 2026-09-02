import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession } from "./helpers/ui-session.js";

function typeKeyOnVideo(code: string): void {
  const video = document.getElementById("remote-video")!;
  video.dispatchEvent(new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true }));
  video.dispatchEvent(new KeyboardEvent("keyup", { code, key: code, bubbles: true, cancelable: true }));
}

describe("Steuerung toggle vs. data-channel readiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The toolbar (incl. #input-toggle) appears on the track event, seconds
  // before DTLS/SCTP finish and the data channels open — longer over TURN.
  // A click in that window used to flip the label to "Steuerung aktiv" while
  // the InputCapture created later started disabled: nothing was forwarded
  // until the helper toggled off and on again.
  it("a toggle pressed before the channels open takes effect once they do", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    session.track(pc);

    const toggle = document.getElementById("input-toggle") as HTMLButtonElement;
    expect(document.getElementById("video-toolbar")!.classList.contains("active")).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await session.openChannels(pc);
    typeKeyOnVideo("KeyA");

    const forwarded = pc.channel("input").sentJson();
    expect(forwarded).toContainEqual(expect.objectContaining({ kind: "key", code: "KeyA", pressed: true }));
    expect(forwarded).toContainEqual(expect.objectContaining({ kind: "key", code: "KeyA", pressed: false }));
  });

  it("toggling off after the channels opened stops forwarding", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    session.track(pc);
    await session.openChannels(pc);

    const toggle = document.getElementById("input-toggle") as HTMLButtonElement;
    toggle.click();
    typeKeyOnVideo("KeyB");
    const afterOn = pc.channel("input").sentJson().length;
    expect(afterOn).toBeGreaterThan(0);

    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    typeKeyOnVideo("KeyC");
    expect(pc.channel("input").sentJson()).toHaveLength(afterOn);
  });

  it("a toggle pressed before the channels open does not forward before they open", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    session.track(pc);
    (document.getElementById("input-toggle") as HTMLButtonElement).click();
    typeKeyOnVideo("KeyA");
    expect(pc.channel("input").sent).toHaveLength(0);
  });
});
