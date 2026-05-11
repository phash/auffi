import { DataChannelHub } from "./data-channels.js";

export type { DataChannelHub };

export type IceServers = { urls: string | string[]; username?: string; credential?: string }[];

export type ConnectionType = "p2p" | "relay";

export type ViewerPeerOpts = {
  iceServers?: IceServers;
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
};

/**
 * Inspects a WebRTC stats report to determine whether the active ICE candidate
 * pair uses a TURN relay or a direct connection.
 *
 * Returns `"relay"` if either the local or remote candidate in the nominated
 * succeeded pair has candidateType `"relay"`, otherwise `"p2p"`.
 */
export function resolveConnectionType(report: RTCStatsReport): ConnectionType | null {
  let activePair: RTCStats & { localCandidateId?: string; remoteCandidateId?: string } | null = null;

  report.forEach((entry: RTCStats) => {
    if (entry.type === "candidate-pair") {
      const pair = entry as RTCStats & {
        state?: string;
        nominated?: boolean;
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      if (pair.state === "succeeded" && pair.nominated) {
        activePair = pair;
      }
    }
  });

  if (!activePair) return null;

  const pair = activePair as {
    localCandidateId?: string;
    remoteCandidateId?: string;
  };
  const localId = pair.localCandidateId;
  const remoteId = pair.remoteCandidateId;

  const localEntry = localId ? (report.get(localId) as (RTCStats & { candidateType?: string }) | undefined) : undefined;
  const remoteEntry = remoteId ? (report.get(remoteId) as (RTCStats & { candidateType?: string }) | undefined) : undefined;

  if (localEntry?.candidateType === "relay" || remoteEntry?.candidateType === "relay") {
    return "relay";
  }
  return "p2p";
}

export class ViewerPeer {
  private pc: RTCPeerConnection | null = null;
  private dataHub: DataChannelHub | null = null;
  private trackHandlers: Array<(stream: MediaStream) => void> = [];
  private iceHandlers: Array<(candidate: RTCIceCandidateInit | null) => void> = [];
  private stateHandlers: Array<(state: RTCIceConnectionState) => void> = [];
  private connectionTypeHandlers: Array<(type: ConnectionType) => void> = [];
  private lastConnectionType: ConnectionType | null = null;

  constructor(private opts: ViewerPeerOpts = {}) {}

  async start(): Promise<RTCSessionDescriptionInit> {
    const factory = this.opts.pcFactory ?? ((c) => new RTCPeerConnection(c));
    const pc = factory({ iceServers: this.opts.iceServers ?? [] });
    this.pc = pc;

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      for (const h of this.trackHandlers) h(stream);
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
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        void pc.getStats().then((report) => {
          const type = resolveConnectionType(report);
          if (type !== null && type !== this.lastConnectionType) {
            this.lastConnectionType = type;
            for (const h of this.connectionTypeHandlers) h(type);
          }
        });
      }
    };

    this.dataHub = new DataChannelHub(pc, "caller");

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

  onConnectionType(fn: (type: ConnectionType) => void): void {
    this.connectionTypeHandlers.push(fn);
  }

  getDataHub(): DataChannelHub {
    if (!this.dataHub) throw new Error("peer not started");
    return this.dataHub;
  }

  close(): void {
    this.dataHub?.close();
    this.dataHub = null;
    this.pc?.close();
    this.pc = null;
    this.lastConnectionType = null;
  }
}
