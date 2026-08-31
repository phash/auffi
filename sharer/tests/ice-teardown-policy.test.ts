import { describe, it, expect } from "vitest";
import {
  planIceState,
  ICE_DISCONNECTED_GRACE_MS,
  type IceState,
} from "../src/ice-teardown-policy.js";

// From a user log, 2026-08-31: ICE reached `disconnected` at t+32 s and the
// sharer encoded 1250 further frames into a peer that was gone — the screen
// stayed captured, the encoder stayed busy, and on a relay path the TURN
// bandwidth and free-tier timer kept running. The viewer has handled this
// since the beginning; the sharer discarded every non-connected state.
describe("planIceState", () => {
  it("tears down at once on the terminal states", () => {
    for (const state of ["failed", "closed"] as const) {
      expect(planIceState(state, false).kind, state).toBe("teardown");
      expect(planIceState(state, true).kind, `${state} while waiting`).toBe("teardown");
    }
  });

  it("grants a grace window on disconnected rather than tearing down", () => {
    // A brief Wi-Fi outage recovers on its own; killing the session on the
    // first blip is exactly what the grace window exists to prevent.
    const plan = planIceState("disconnected", false);
    expect(plan.kind).toBe("arm-grace");
    expect(plan.kind === "arm-grace" && plan.status).toContain("instabil");
  });

  it("does not restart the window on a flapping link", () => {
    // Re-arming on every repeat would postpone the teardown indefinitely.
    expect(planIceState("disconnected", true).kind).toBe("ignore");
  });

  it("cancels a pending window when the connection comes back", () => {
    for (const state of ["connected", "completed"] as const) {
      expect(planIceState(state, true).kind, state).toBe("recovered");
      expect(planIceState(state, false).kind, `${state} without a pending window`).toBe(
        "ignore",
      );
    }
  });

  it("ignores the states that carry no decision", () => {
    for (const state of ["new", "checking"] as IceState[]) {
      expect(planIceState(state, false).kind, state).toBe("ignore");
      expect(planIceState(state, true).kind, `${state} while waiting`).toBe("ignore");
    }
  });

  it("grants the same window the viewer does", () => {
    // Asymmetric windows would mean one side gives up while the other is
    // still waiting for the very same link to recover.
    expect(ICE_DISCONNECTED_GRACE_MS).toBe(10_000);
  });
});
