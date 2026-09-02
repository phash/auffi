import { describe, it, expect } from "vitest";
import { planViewerBye } from "../src/viewer-bye-policy.js";

// The relay `bye` reaches the ad-hoc sharer in two situations the old branch
// did not tell apart: the helper pressed Beenden mid-stream, or the backend
// synthesized it because an UNCONFIRMED viewer closed its tab while the
// "Verbindungsanfrage" dialog was still up. Both got a full teardown that
// released the code the user had just read aloud, and the pre-confirm case
// additionally left the dialog open with an Accept that could only fail.
describe("planViewerBye", () => {
  it("dismisses a pending request and keeps the code when no stream existed", () => {
    const plan = planViewerBye({ confirmPending: true, freeTierCutoffSeen: false });
    expect(plan.kind).toBe("dismiss-confirm");
    expect(plan.status).toContain("Code bleibt gültig");
    expect(plan.status).not.toContain("beendet");
  });

  it("ignores the free-tier flag before a stream ever existed", () => {
    const plan = planViewerBye({ confirmPending: true, freeTierCutoffSeen: true });
    expect(plan.kind).toBe("dismiss-confirm");
    expect(plan.status).not.toContain("Zeitlimit");
  });

  it("ends the stream with the friendly copy when the helper left mid-stream", () => {
    const plan = planViewerBye({ confirmPending: false, freeTierCutoffSeen: false });
    expect(plan).toEqual({ kind: "end-stream", status: "Helfer hat die Verbindung beendet." });
  });

  it("names the relay time limit when the cutoff preceded the bye", () => {
    const plan = planViewerBye({ confirmPending: false, freeTierCutoffSeen: true });
    expect(plan.kind).toBe("end-stream");
    expect(plan.status).toContain("Zeitlimit");
  });
});
