import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, flush } from "./helpers/ui-session.js";

function status(): string {
  return document.getElementById("status")!.textContent ?? "";
}

describe("relay messages from the sharer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a remote ICE candidate the browser refuses does not end the session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = await startUiSession();
    const pc = await session.confirm();
    pc.addIceCandidate = async () => {
      throw new DOMException("bad candidate", "OperationError");
    };
    session.ws.fakeMessage({ type: "relay", payload: { kind: "sdp", sdp: { type: "answer", sdp: "v=0" } } });
    await flush();
    session.track(pc);
    session.ws.fakeMessage({ type: "relay", payload: { kind: "ice", candidate: { candidate: "candidate:x", sdpMid: "0" } } });
    await flush();

    expect(document.getElementById("video-wrapper")!.classList.contains("active")).toBe(true);
    expect(status()).not.toContain("ICE");
    expect(session.ws.readyState).not.toBe(3);
    expect(warn).toHaveBeenCalled();
  });

  it("a failing answer ends the connect attempt with the generic copy, not the DOMException", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const session = await startUiSession();
    const pc = await session.confirm();
    pc.setRemoteDescription = async () => {
      throw new DOMException("Failed to parse SessionDescription", "OperationError");
    };
    session.ws.fakeMessage({ type: "relay", payload: { kind: "sdp", sdp: { type: "answer", sdp: "garbage" } } });
    await flush();

    expect(status()).toBe("Verbindung fehlgeschlagen. Bitte erneut versuchen.");
    expect(error).toHaveBeenCalled();
  });
});
