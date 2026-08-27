import { describe, it, expect } from "vitest";
import { planUnattendedTerminal } from "../src/unattended-terminal-policy.js";

// A revoked token is the documented kill switch for a stolen or compromised
// machine, but the terminal handlers only cleared the heartbeat's command slot
// and OutboundSink. Once ICE is nominated the media and the input DataChannel
// are peer-to-peer and need no signaling at all, so the helper kept full
// mouse/keyboard control after the owner deleted the device in the dashboard.
// The same hole applied to "superseded".
describe("planUnattendedTerminal", () => {
  it("tears the live session down when a revoked token arrives mid-stream", () => {
    const plan = planUnattendedTerminal("revoked", true);
    expect(plan.tearDownStream).toBe(true);
    // keepSignaling mirrors every other unattended teardown: the heartbeat
    // owns its OutboundSink, and the full-teardown path is shaped for ad-hoc.
    expect(plan.keepSignaling).toBe(true);
    expect(plan.status).toContain("widerrufen");
    expect(plan.status).toContain("beendet");
  });

  it("tears the live session down when another instance supersedes this one", () => {
    const plan = planUnattendedTerminal("superseded", true);
    expect(plan.tearDownStream).toBe(true);
    expect(plan.keepSignaling).toBe(true);
    expect(plan.status).toContain("übernommen");
  });

  it("does not invoke a teardown when no session was running", () => {
    for (const kind of ["revoked", "superseded"] as const) {
      const plan = planUnattendedTerminal(kind, false);
      expect(plan.tearDownStream, `${kind} without a live stream`).toBe(false);
    }
  });

  it("keeps the idle copy free of the session-ended clause", () => {
    // Telling someone their session was ended when none existed is noise.
    expect(planUnattendedTerminal("revoked", false).status).not.toContain("beendet");
    expect(planUnattendedTerminal("revoked", false).status).toContain("widerrufen");
  });

  it("marks the device inactive for both kinds regardless of streaming", () => {
    for (const kind of ["revoked", "superseded"] as const) {
      for (const streaming of [true, false]) {
        expect(planUnattendedTerminal(kind, streaming).stillActive).toBe(false);
      }
    }
  });
});
