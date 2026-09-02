// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { resetSessionIndicators } from "../src/session-indicators.js";

function el(id: string, className = ""): HTMLElement {
  const node = document.createElement("div");
  node.id = id;
  node.className = className;
  return node;
}

// The peer-joined swap cleared these five indicators inline; the ICE-loss
// path (keepSignaling teardown, whose streaming-stopped event the listener
// deliberately ignores) cleared none of them. After the helper's link died
// the sharer showed "Verbindung verloren." beside a live "Beenden",
// "Datei senden" and "Verbindung: über Relay" — controls that could only
// fail against the torn-down peer.
describe("resetSessionIndicators", () => {
  it("clears every per-session indicator and brings the how-to back", () => {
    const els = {
      streamingActions: el("streaming-actions", "visible"),
      howtoCard: el("howto-card", "card hidden"),
      pauseBanner: el("pause-banner", "visible"),
      freeTierBanner: el("free-tier-banner", "visible"),
      connTypeInfo: el("connection-type-info", "visible relay"),
    };
    els.connTypeInfo.textContent = "Verbindung: über Relay";

    resetSessionIndicators(els);

    expect(els.streamingActions.classList.contains("visible")).toBe(false);
    expect(els.pauseBanner.classList.contains("visible")).toBe(false);
    expect(els.freeTierBanner.classList.contains("visible")).toBe(false);
    expect(els.howtoCard.classList.contains("hidden")).toBe(false);
    expect(els.howtoCard.classList.contains("card")).toBe(true);
    expect(els.connTypeInfo.textContent).toBe("");
    expect(els.connTypeInfo.className).toBe("");
  });

  it("is idempotent on an already idle UI", () => {
    const els = {
      streamingActions: el("streaming-actions"),
      howtoCard: el("howto-card", "card"),
      pauseBanner: el("pause-banner"),
      freeTierBanner: el("free-tier-banner"),
      connTypeInfo: el("connection-type-info"),
    };
    expect(() => resetSessionIndicators(els)).not.toThrow();
    expect(els.howtoCard.className).toBe("card");
  });
});
