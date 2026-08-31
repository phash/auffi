/**
 * What the sharer does when the peer's ICE state changes.
 *
 * The sharer had no answer to this at all: `webrtc_peer.rs` reacted only to
 * `connected`/`completed` and discarded everything else. A user log from
 * 2026-08-31 shows the consequence — ICE went to `disconnected` and the sharer
 * encoded and sent 1250 further frames into a peer nobody was on the other end
 * of, keeping the screen capture (and on Wayland its portal indicator) alive
 * indefinitely.
 *
 * Mirrors `viewer/src/ice-state-handler.ts` deliberately: `disconnected` is
 * usually a brief Wi-Fi blip that recovers on its own, so it gets a grace
 * window; `failed` and `closed` are terminal and stop the stream at once.
 *
 * Pure so the decision is testable without a Tauri runtime — the caller owns
 * the timer and the invoking.
 */

export type IceState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "disconnected"
  | "failed"
  | "closed";

export type IceAction =
  /** Nothing to do. */
  | { kind: "ignore" }
  /** Stop the stream now. */
  | { kind: "teardown"; status: string }
  /** Start (or keep) the grace timer; tear down when it expires. */
  | { kind: "arm-grace"; status: string }
  /** The blip recovered — cancel a pending grace timer. */
  | { kind: "recovered"; status: string };

/** Same window the viewer grants, for the same reason. */
export const ICE_DISCONNECTED_GRACE_MS = 10_000;

export function planIceState(state: IceState, gracePending: boolean): IceAction {
  if (state === "failed" || state === "closed") {
    return { kind: "teardown", status: "Verbindung verloren." };
  }
  if (state === "disconnected") {
    // Re-entering disconnected while already waiting must not restart the
    // window, or a flapping link postpones the teardown forever.
    if (gracePending) return { kind: "ignore" };
    return { kind: "arm-grace", status: "Verbindung instabil …" };
  }
  if (state === "connected" || state === "completed") {
    return gracePending
      ? { kind: "recovered", status: "Streaming läuft." }
      : { kind: "ignore" };
  }
  return { kind: "ignore" };
}
