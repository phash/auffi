// Shared SDP/ICE buffering for both sharer flows (ad-hoc main.ts and
// unattended unattended.ts).
//
// The viewer sends its offer immediately after `peer-confirmed`, but the
// Rust WebRTC peer only exists once `start_streaming` resolves (TURN
// fetch + capturer startup — up to seconds on WGC / the Wayland portal).
// An offer or candidate invoked against the not-yet-built peer errors
// with "WebRTC peer not initialized" and is lost, dead-ending the viewer
// into its 30 s media backstop. So: buffer until the caller marks the
// stream ready, then replay in order.

/** Shape `receive_ice_candidate` expects. Tauri maps the Rust arg
 *  `sdp_mline_index` to the camelCase invoke key `sdpMlineIndex`
 *  (lowercase l!) — NOT the wire/browser key `sdpMLineIndex`. Both
 *  relay paths must normalize through this type or the mline index
 *  silently deserializes to None. Type alias (not interface) so it
 *  stays assignable to Tauri's `InvokeArgs` record. */
export type IcePayload = {
  candidate: string;
  sdpMid: string | null;
  sdpMlineIndex: number | null;
  usernameFragment: string | null;
};

export type WireIceCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

/** Wire (browser `RTCIceCandidateInit`) → Tauri invoke args. */
export function normalizeIceCandidate(wire: WireIceCandidate): IcePayload {
  return {
    candidate: wire.candidate ?? "",
    sdpMid: wire.sdpMid ?? null,
    sdpMlineIndex: wire.sdpMLineIndex ?? null,
    usernameFragment: wire.usernameFragment ?? null,
  };
}

export interface SignalingBufferSinks {
  /** Deliver an offer to the live peer (invoke receive_offer). */
  sendOffer(sdp: string): Promise<void>;
  /** Deliver a candidate to the live peer (invoke receive_ice_candidate). */
  sendIce(ice: IcePayload): Promise<void>;
}

export class SignalingBuffer {
  private streamingReady = false;
  private pendingOffer: string | null = null;
  private pendingIce: IcePayload[] = [];

  constructor(private readonly sinks: SignalingBufferSinks) {}

  /** Route an incoming offer: forward when ready, buffer otherwise.
   *  A buffered offer replaces any previous one — only the newest
   *  offer may be replayed against the fresh peer. */
  offer(sdp: string): void {
    if (!this.streamingReady) {
      this.pendingOffer = sdp;
      return;
    }
    void this.sinks.sendOffer(sdp);
  }

  /** Route an incoming wire candidate (normalized here so no caller
   *  can bypass the sdpMlineIndex key mapping). */
  ice(wire: WireIceCandidate): void {
    const ice = normalizeIceCandidate(wire);
    if (!this.streamingReady) {
      this.pendingIce.push(ice);
      return;
    }
    void this.sinks.sendIce(ice);
  }

  /** Mark the stream live and replay everything buffered, offer first,
   *  candidates in arrival order. Call after start_streaming resolves. */
  async ready(): Promise<void> {
    this.streamingReady = true;
    if (this.pendingOffer !== null) {
      const sdp = this.pendingOffer;
      this.pendingOffer = null;
      await this.sinks.sendOffer(sdp);
    }
    const ice = this.pendingIce.splice(0);
    for (const c of ice) {
      await this.sinks.sendIce(c);
    }
  }

  /** Drop ready-state and buffers — the next session starts fresh.
   *  Without this, a stale ready=true from the previous session makes
   *  the relay handler invoke against a peer that isn't built yet. */
  reset(): void {
    this.streamingReady = false;
    this.pendingOffer = null;
    this.pendingIce = [];
  }

  /** True while a session is live or handshake material is buffered —
   *  the peer-joined guard uses this to tear stale state down first. */
  hasActivity(): boolean {
    return this.streamingReady || this.pendingOffer !== null || this.pendingIce.length > 0;
  }
}
