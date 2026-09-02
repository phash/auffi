/**
 * Per-session indicators the ad-hoc UI shows while a helper is connected:
 * the streaming action row, the input-pause and free-tier banners, the
 * direct/relay label, and the "So geht's" recap that hides during a session.
 *
 * Several teardown paths run with `keepSignaling: true` (viewer swap, ICE
 * loss, viewer bye) whose `streaming-stopped` event the listener deliberately
 * ignores — so each of them has to clear these itself. One helper instead of
 * three inline copies that drifted apart. Session state (code, IP prefix,
 * signaling buffer) stays with the caller: the code is still valid on most of
 * these paths.
 */
export interface SessionIndicatorElements {
  streamingActions: HTMLElement;
  howtoCard: HTMLElement;
  pauseBanner: HTMLElement;
  freeTierBanner: HTMLElement;
  connTypeInfo: HTMLElement;
}

export function resetSessionIndicators(els: SessionIndicatorElements): void {
  els.streamingActions.classList.remove("visible");
  els.howtoCard.classList.remove("hidden");
  els.pauseBanner.classList.remove("visible");
  els.freeTierBanner.classList.remove("visible");
  els.connTypeInfo.textContent = "";
  els.connTypeInfo.className = "";
}
