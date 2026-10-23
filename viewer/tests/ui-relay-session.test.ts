import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, flush, type MockPC } from "./helpers/ui-session.js";

function relayStats(): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>([
    ["pair", { type: "candidate-pair", id: "pair", state: "succeeded", nominated: true, localCandidateId: "l", remoteCandidateId: "r" }],
    ["l", { type: "local-candidate", id: "l", candidateType: "relay" }],
    ["r", { type: "remote-candidate", id: "r", candidateType: "host" }],
  ]);
  return map as unknown as RTCStatsReport;
}

async function goRelay(pc: MockPC): Promise<void> {
  pc.getStats = async () => relayStats();
  pc.fireIceState("connected");
  await flush();
}

// Product decision for v0.7.2: a session over the TURN relay has no time
// limit any more. The old free-tier timer tore it down after 10 minutes.
describe("relay sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a relayed session alive well past the former 10-minute cap", async () => {
    vi.useFakeTimers();
    const session = await startUiSession();
    const pc = await session.confirm();
    session.track(pc);
    (document.getElementById("remote-video") as HTMLVideoElement).dispatchEvent(new Event("playing"));
    await goRelay(pc);
    expect(document.getElementById("connection-type")!.textContent).toBe("Über Relay");

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(document.getElementById("status")!.textContent).toBe("Stream läuft.");
    expect(document.getElementById("video-wrapper")!.classList.contains("active")).toBe(true);
    expect(session.ws.readyState).not.toBe(3);
  });
});
