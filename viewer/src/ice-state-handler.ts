// Debounced ICE connection-state handler for the viewer.
//
// `disconnected` is often transient — a brief Wi-Fi outage usually recovers
// within a few seconds and WebRTC reconnects on its own. Tearing the
// session down on the first blip kills recoverable connections, so we
// grant a grace window before declaring the session lost. `failed` and
// `closed` still tear down immediately because they are terminal.

import { t } from "./i18n.js";
import type { StatusKind } from "./status-kind.js";

export interface IceStateCallbacks {
  teardown: (reason: string, kind: StatusKind, canReconnect: boolean) => void;
  setStatus: (text: string, kind: StatusKind) => void;
  /** true once the first frame was decoded. */
  isStreaming: () => boolean;
}

export interface IceStateHandlerOptions {
  graceMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export const DEFAULT_ICE_DISCONNECTED_GRACE_MS = 10_000;

export function createIceStateHandler(
  cb: IceStateCallbacks,
  opts: IceStateHandlerOptions = {},
): {
  handle: (state: RTCIceConnectionState) => void;
  clear: () => void;
  isPending: () => boolean;
} {
  const graceMs = opts.graceMs ?? DEFAULT_ICE_DISCONNECTED_GRACE_MS;
  const setTimer = opts.setTimeoutFn ?? setTimeout;
  const clearTimer = opts.clearTimeoutFn ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;

  // ICE giving up before a single frame arrived is the blocked-network case
  // (no P2P path, TURN unreachable) — "Verbindung verloren" would claim a
  // working connection dropped; the firewall hint says what to try instead.
  const lostText = (): string => (cb.isStreaming() ? t("ice.lost") : t("timeout.firewall"));

  function clearTimer_(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function handle(state: RTCIceConnectionState): void {
    if (state === "failed" || state === "closed") {
      clearTimer_();
      cb.teardown(lostText(), "err", true);
      return;
    }
    if (state === "disconnected") {
      if (timer !== null) return;
      cb.setStatus(t("ice.unstable"), "info");
      timer = setTimer(() => {
        timer = null;
        cb.teardown(lostText(), "err", true);
      }, graceMs);
      return;
    }
    if (state === "connected" || state === "completed") {
      if (timer !== null) {
        clearTimer_();
        cb.setStatus(t("status.streamRunning"), "ok");
      }
    }
  }

  return {
    handle,
    clear: clearTimer_,
    isPending: () => timer !== null,
  };
}
