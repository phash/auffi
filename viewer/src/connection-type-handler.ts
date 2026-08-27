// Detached, unit-testable handler for connection-type changes (relay ⇄ p2p),
// mirroring ice-state-handler.ts.
//
// ViewerPeer re-resolves the nominated candidate pair after every ICE
// connected/completed transition and fires on change — after a Wi-Fi blip a
// session can genuinely switch relay→p2p (or back). The free-tier cutoff
// only applies WHILE media rides the TURN relay, so the timer must stop on
// relay→p2p (and the warning toast must clear), and a relay re-entry must
// stop the old timer before starting a new one — a replaced instance would
// keep running with its onCutoff pointed at the long-lived teardown() and
// could kill a later session.

import { FreeTierTimer } from "./free-tier-timer.js";
import type { ConnectionType } from "./webrtc-client.js";

export interface ConnectionTypeCallbacks {
  onWarning: () => void;
  onCutoff: () => void;
  /** Fired whenever the session is NOT on the relay (also on plain p2p) —
   *  hides the free-tier warning toast if it was up. */
  onLeftRelay: () => void;
}

export function createConnectionTypeHandler(
  cb: ConnectionTypeCallbacks,
  makeTimer: () => FreeTierTimer = () => new FreeTierTimer(),
): { handle: (type: ConnectionType) => void; stop: () => void } {
  let timer: FreeTierTimer | null = null;

  const stop = (): void => {
    timer?.stop();
    timer = null;
  };

  const handle = (type: ConnectionType): void => {
    stop();
    if (type === "relay") {
      timer = makeTimer();
      timer.start({ onWarning: cb.onWarning, onCutoff: cb.onCutoff });
    } else {
      cb.onLeftRelay();
    }
  };

  return { handle, stop };
}
