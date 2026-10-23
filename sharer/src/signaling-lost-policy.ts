/**
 * What the ad-hoc UI does when the signaling WebSocket dies.
 *
 * `signaling.rs` emits `disconnected` for WS-level conditions only (Close
 * frame, read error, EOF, pong timeout, backend `error`) and then exits its
 * task — the WebRTC peer, the input controller and the file manager are
 * untouched. Once ICE is nominated, media and remote input run peer-to-peer
 * without the signaling channel, so a backend restart during a live session
 * leaves the helper's screen and mouse control fully working. Hiding Beenden
 * in that state (what the listener used to do) took away the only honest
 * stop control; offering "Neu verbinden" instead would tear the stream down
 * under a misleading label.
 *
 * Pure so the decision is testable without a Tauri runtime.
 */

import { friendlyDisconnectReason, isCodeExpiredClose } from "./disconnect-reason.js";

export interface SignalingLostPlan {
  /** Leave Beenden / Bildschirm wechseln / Datei senden on screen. */
  keepStreamingActions: boolean;
  /** Offer "Neu verbinden" — only when no stream is live. */
  showReconnect: boolean;
  /**
   * Offer "Neuer Code" instead: the backend closed with 4410 because the code
   * expired, so reconnecting would only find a dead code.
   */
  showNewCode: boolean;
  /** German status line. */
  status: string;
}

export function planSignalingLost(streamActive: boolean, reason: string): SignalingLostPlan {
  if (streamActive) {
    return {
      keepStreamingActions: true,
      showReconnect: false,
      showNewCode: false,
      status:
        "Verbindung zum Server verloren — die Übertragung läuft weiter. " +
        "Mit „Beenden“ kannst du sie stoppen.",
    };
  }
  const expired = isCodeExpiredClose(reason);
  return {
    keepStreamingActions: false,
    showReconnect: !expired,
    showNewCode: expired,
    status: friendlyDisconnectReason(reason),
  };
}
