// Policy for the "streaming-stopped" Tauri event. Extracted from main.ts
// because the listener races two other writers of the same UI state:
//
//  - Viewer-swap (`keepSignaling: true`): the peer-joined handler already
//    tore down the stream itself and then set up state for the NEW helper
//    (currentIpPrefix, hidden Neuer-Code button, confirm dialog). Tauri
//    gives no cross-ordering guarantee between event delivery and invoke
//    resolution, so the event may arrive after that setup — touching the
//    session UI here would null the new helper's IP and break the
//    "Diesen Helfer merken" checkbox.
//
//  - bye / stop-confirm / decline: those paths set a specific, friendly
//    status ("Helfer hat die Verbindung beendet.", …) and then invoke
//    disconnect_streaming, which always emits this event ~100 ms later.
//    Overwriting with the generic "Stream beendet." would defeat the
//    entire point of those messages.

export interface StreamingStoppedPlan {
  /** Reset code/status/session UI — only on a full teardown. */
  resetSessionUi: boolean;
  /** Show the generic "Stream beendet." status. */
  showGenericStatus: boolean;
}

export function planStreamingStopped(
  keepSignaling: boolean,
  specificStatusSet: boolean,
): StreamingStoppedPlan {
  if (keepSignaling) {
    return { resetSessionUi: false, showGenericStatus: false };
  }
  return { resetSessionUi: true, showGenericStatus: !specificStatusSet };
}

/**
 * German status line for the "streaming-failed" Tauri event — the
 * streaming loop's abnormal self-exit (`emit_streaming_failed` in
 * lib.rs). Reasons are the Rust-side literals; anything unknown gets
 * the generic internal-error copy so a new reason never surfaces as
 * raw protocol text.
 */
export function streamingFailedMessage(reason: string): string {
  switch (reason) {
    case "capture":
      return "Bildschirmaufnahme unterbrochen — die Übertragung wurde beendet.";
    case "track-write":
      return "Verbindung zum Helfer verloren — die Übertragung wurde beendet.";
    default:
      return "Interner Fehler — die Übertragung wurde beendet.";
  }
}
