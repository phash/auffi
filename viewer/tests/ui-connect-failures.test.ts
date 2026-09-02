import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, flush } from "./helpers/ui-session.js";

describe("connection failures after the sharer confirmed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The status line is read by a non-technical helper. A malformed answer
  // used to interpolate the browser's English DOMException verbatim
  // ("SDP-Fehler: Failed to execute 'setRemoteDescription' on …") and
  // offered no reconnect.
  it("a rejected SDP answer shows friendly copy, offers reconnect and logs the raw error", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    pc.setRemoteDescription = async () => {
      throw new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection'");
    };

    session.ws.fakeMessage({ type: "relay", payload: { kind: "sdp", sdp: { type: "answer", sdp: "garbage" } } });
    await flush();

    const status = document.getElementById("status")!.textContent ?? "";
    expect(status).not.toContain("Failed to execute");
    expect(status).not.toContain("SDP");
    expect(status).toContain("Verbindung fehlgeschlagen");
    expect(document.getElementById("reconnect-wrap")!.classList.contains("active")).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("setRemoteDescription"), expect.anything());
  });

  it("peer-rejected: sharer-gone after confirm tears down with the sharer-gone copy at once", async () => {
    vi.useFakeTimers();
    try {
      const session = await startUiSession();
      const { CONNECT_MEDIA_TIMEOUT_MS } = await import("../src/ui.js");
      await session.confirm();

      session.ws.fakeMessage({ type: "peer-rejected", reason: "sharer-gone" });
      session.ws.close();

      const status = document.getElementById("status")!;
      expect(status.textContent).toContain("nicht mehr erreichbar");
      expect(document.getElementById("reconnect-wrap")!.classList.contains("active")).toBe(true);

      // The media backstop was cleared by the teardown — it must not
      // overwrite the specific copy with the generic "kein Bild" one later.
      const shown = status.textContent;
      vi.advanceTimersByTime(CONNECT_MEDIA_TIMEOUT_MS + 1);
      expect(status.textContent).toBe(shown);
    } finally {
      vi.useRealTimers();
    }
  });
});
