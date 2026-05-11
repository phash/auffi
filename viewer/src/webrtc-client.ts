export type IceServers = { urls: string | string[]; username?: string; credential?: string }[];

export type ViewerPeerOpts = {
  iceServers?: IceServers;
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
};

const DEFAULT_ICE: IceServers = [{ urls: "stun:stun.l.google.com:19302" }];

export class ViewerPeer {
  private pc: RTCPeerConnection | null = null;
  private trackHandlers: Array<(stream: MediaStream) => void> = [];
  private iceHandlers: Array<(candidate: RTCIceCandidateInit | null) => void> = [];
  private stateHandlers: Array<(state: RTCIceConnectionState) => void> = [];

  constructor(private opts: ViewerPeerOpts = {}) {}

  async start(): Promise<RTCSessionDescriptionInit> {
    const factory = this.opts.pcFactory ?? ((c) => new RTCPeerConnection(c));
    const pc = factory({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    this.pc = pc;

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) for (const h of this.trackHandlers) h(stream);
    };
    pc.onicecandidate = (ev) => {
      const c: RTCIceCandidateInit | null = ev.candidate
        ? {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
            usernameFragment: ev.candidate.usernameFragment,
          }
        : null;
      for (const h of this.iceHandlers) h(c);
    };
    pc.oniceconnectionstatechange = () => {
      for (const h of this.stateHandlers) h(pc.iceConnectionState);
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) throw new Error("peer not started");
    await this.pc.setRemoteDescription(sdp);
  }

  async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) throw new Error("peer not started");
    await this.pc.addIceCandidate(candidate);
  }

  onTrack(fn: (stream: MediaStream) => void): void {
    this.trackHandlers.push(fn);
  }

  onIceCandidate(fn: (candidate: RTCIceCandidateInit | null) => void): void {
    this.iceHandlers.push(fn);
  }

  onIceState(fn: (state: RTCIceConnectionState) => void): void {
    this.stateHandlers.push(fn);
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
  }
}
