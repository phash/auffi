/**
 * What the ad-hoc sharer does with a relay `bye`.
 *
 * Two senders produce it (docs/protocol.md § Bye): the helper pressing Beenden
 * or Abbrechen mid-stream, and the backend synthesizing it when an UNCONFIRMED
 * viewer's WS drops or the code expires under it — "the sharer's confirm
 * dialog would otherwise point at a gone viewer". Either way the helper is
 * gone but this sharer is not: the backend's `detachViewer` keeps the session,
 * so the code stays redeemable until its TTL and the viewer's own 30 s
 * "doch nochmal verbinden" (gh #71) expects to find it. Tearing signaling
 * down here released the code every time and left the dialog standing.
 *
 * Pure so the decision is testable without a Tauri runtime.
 */
export type ViewerByePlan =
  /** Pre-confirm: close the request, nothing else was set up. */
  | { kind: "dismiss-confirm"; status: string }
  /** Mid-stream: drop the WebRTC session, keep the signaling registration. */
  | { kind: "end-stream"; status: string };

export function planViewerBye(input: {
  confirmPending: boolean;
  freeTierCutoffSeen: boolean;
}): ViewerByePlan {
  if (input.confirmPending) {
    return {
      kind: "dismiss-confirm",
      status: "Helfer hat die Anfrage abgebrochen — der Code bleibt gültig.",
    };
  }
  return {
    kind: "end-stream",
    status: input.freeTierCutoffSeen
      ? "Übertragung beendet — Zeitlimit für kostenlose Relay-Verbindungen erreicht."
      : "Helfer hat die Verbindung beendet.",
  };
}
