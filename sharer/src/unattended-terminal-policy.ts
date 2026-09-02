/**
 * What to do when the heartbeat reports a TERMINAL unattended event.
 *
 * `revoked` (WS 4401, the owner deleted the device) and `superseded` (4408,
 * another instance took over) end the pairing, but the Rust side only clears
 * the heartbeat's command slot and OutboundSink. The WebRTC peer, the input
 * controller and the file-transfer manager are untouched — and once ICE is
 * nominated, media and the input DataChannel run peer-to-peer with no
 * signaling involved. So without an explicit teardown the helper keeps full
 * mouse and keyboard control after the device was revoked, which defeats the
 * point of revoking it.
 *
 * Pure so the decision is testable without a Tauri runtime; the caller does
 * the invoking.
 */

export type UnattendedTerminalKind = "revoked" | "superseded";

export interface UnattendedTerminalPlan {
  /** Invoke `disconnect_streaming` — only meaningful if a session was live. */
  tearDownStream: boolean;
  /**
   * Always true: the heartbeat owns its OutboundSink and the full-teardown
   * path is shaped around the ad-hoc lifecycle. Every other unattended
   * teardown passes this, and a terminal event is no reason to differ.
   */
  keepSignaling: boolean;
  /** Status line for the user. */
  status: string;
  /** Whether unattended mode is still active afterwards (never, here). */
  stillActive: boolean;
}

export function planUnattendedTerminal(
  kind: UnattendedTerminalKind,
  streaming: boolean,
): UnattendedTerminalPlan {
  const base =
    kind === "revoked"
      ? "Zugriff widerrufen — bitte Gerät erneut koppeln."
      : "Eine andere Instanz hat übernommen.";
  const ended =
    kind === "revoked"
      ? "Zugriff widerrufen — Sitzung beendet, bitte Gerät erneut koppeln."
      : "Eine andere Instanz hat übernommen — Sitzung beendet.";

  return {
    tearDownStream: streaming,
    keepSignaling: true,
    status: streaming ? ended : base,
    stillActive: false,
  };
}
