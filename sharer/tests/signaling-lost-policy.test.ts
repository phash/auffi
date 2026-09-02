import { describe, it, expect } from "vitest";
import { planSignalingLost } from "../src/signaling-lost-policy.js";

// The `disconnected` event only means the signaling WebSocket died — a
// backend restart during ./ops/deploy.sh, or a 30 s pong timeout. Media and
// remote input keep flowing peer-to-peer. The listener nevertheless hid
// Beenden / Bildschirm wechseln / Datei senden, so the helper kept driving
// the mouse while the sharer-user had no visible way to end it.
describe("planSignalingLost", () => {
  it("keeps the streaming controls while a stream is live and says so", () => {
    const plan = planSignalingLost(true, "socket EOF");
    expect(plan.keepStreamingActions).toBe(true);
    // "Neu verbinden" runs a full teardown — offering it next to a live
    // stream is a silent kill switch; Beenden is the honest one.
    expect(plan.showReconnect).toBe(false);
    expect(plan.status).toContain("läuft weiter");
    expect(plan.status).toContain("Beenden");
  });

  it("offers the reconnect path when nothing was streaming", () => {
    const plan = planSignalingLost(false, "socket EOF");
    expect(plan.keepStreamingActions).toBe(false);
    expect(plan.showReconnect).toBe(true);
  });

  it("uses the friendly reason copy pre-stream, never the raw reason", () => {
    const plan = planSignalingLost(false, "no pong for 31s");
    expect(plan.status).toContain("antwortet nicht");
    expect(plan.status).not.toContain("pong");
  });
});
