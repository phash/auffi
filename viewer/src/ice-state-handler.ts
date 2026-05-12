// Debounced ICE connection-state handler for the viewer.
//
// `disconnected` is often transient — a brief Wi-Fi outage usually recovers
// within a few seconds and WebRTC reconnects on its own. Tearing the
// session down on the first blip kills recoverable connections, so we
// grant a grace window before declaring the session lost. `failed` and
// `closed` still tear down immediately because they are terminal.

export type StatusKind = "ok" | "err" | "info";

export interface IceStateCallbacks {
  teardown: (reason: string, kind: StatusKind, canReconnect: boolean) => void;
  setStatus: (text: string, kind: StatusKind) => void;
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

  function clearTimer_(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function handle(state: RTCIceConnectionState): void {
    if (state === "failed" || state === "closed") {
      clearTimer_();
      cb.teardown("Verbindung verloren.", "err", true);
      return;
    }
    if (state === "disconnected") {
      if (timer !== null) return;
      cb.setStatus("Verbindung instabil — versuche, sie wiederherzustellen…", "info");
      timer = setTimer(() => {
        timer = null;
        cb.teardown("Verbindung verloren.", "err", true);
      }, graceMs);
      return;
    }
    if (state === "connected" || state === "completed") {
      if (timer !== null) {
        clearTimer_();
        cb.setStatus("Stream läuft.", "ok");
      }
    }
  }

  return {
    handle,
    clear: clearTimer_,
    isPending: () => timer !== null,
  };
}
