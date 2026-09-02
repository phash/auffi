import { describe, it, expect, vi } from "vitest";
import { ViewerPeer } from "../src/webrtc-client.js";

type StatsEntry = {
  type: string;
  id: string;
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
};

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((e: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  statsEntries: StatsEntry[] = [];
  constructor(_config?: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n" };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { ...d, toJSON: () => ({}) } as RTCSessionDescription;
  }
  async setRemoteDescription(_d: RTCSessionDescriptionInit): Promise<void> {}
  async addIceCandidate(_c: RTCIceCandidateInit): Promise<void> {}
  addTransceiver(_kind: string, _init: { direction: RTCRtpTransceiverDirection }): void {}
  createDataChannel(_label: string, _init?: RTCDataChannelInit): RTCDataChannel {
    return { onopen: null, onmessage: null, send: () => {}, close: () => {} } as unknown as RTCDataChannel;
  }
  close(): void { this.iceConnectionState = "closed"; }
  async getStats(): Promise<RTCStatsReport> {
    const map = new Map<string, StatsEntry>();
    for (const entry of this.statsEntries) {
      map.set(entry.id, entry);
    }
    return map as unknown as RTCStatsReport;
  }
}

describe("ViewerPeer", () => {
  it("creates an SDP offer when started", async () => {
    MockRTCPeerConnection.instances = [];
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const offer = await peer.start();
    expect(offer.type).toBe("offer");
    expect(offer.sdp).toContain("v=0");
  });

  it("emits onTrack when remote track arrives", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onTrack(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    const stream = { id: "s1" } as unknown as MediaStream;
    const track = {} as unknown as MediaStreamTrack;
    pc.ontrack?.({ streams: [stream], track });
    expect(handler).toHaveBeenCalledWith(stream);
  });

  it("emits onIceCandidate for outgoing candidates", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onIceCandidate(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.onicecandidate?.({ candidate: { candidate: "candidate:...", sdpMid: "0", sdpMLineIndex: 0 } as RTCIceCandidate });
    expect(handler).toHaveBeenCalled();
  });

  it("accepts remote answer", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    await expect(peer.acceptAnswer({ type: "answer", sdp: "v=0\r\n" })).resolves.toBeUndefined();
  });

  it("accepts remote ICE candidates", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    await expect(
      peer.addRemoteIceCandidate({ candidate: "candidate:...", sdpMid: "0", sdpMLineIndex: 0 })
    ).resolves.toBeUndefined();
  });

  it("close terminates the underlying PC", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    peer.close();
    expect(pc.iceConnectionState).toBe("closed");
  });

  it("throws when acceptAnswer called before start", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await expect(peer.acceptAnswer({ type: "answer", sdp: "v=0\r\n" })).rejects.toThrow("peer not started");
  });

  it("throws when addRemoteIceCandidate called before start", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await expect(
      peer.addRemoteIceCandidate({ candidate: "candidate:..." })
    ).rejects.toThrow("peer not started");
  });

  it("emits null ICE candidate when candidate is null (gathering complete)", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onIceCandidate(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.onicecandidate?.({ candidate: null });
    expect(handler).toHaveBeenCalledWith(null);
  });

  it("emits onIceState when connection state changes", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onIceState(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    expect(handler).toHaveBeenCalledWith("connected");
  });

  it("emits onTrack with a synthetic stream when track event has no streams", async () => {
    const track = {} as unknown as MediaStreamTrack;
    const capturedArgs: MediaStreamTrack[][] = [];
    class FakeMediaStream {
      constructor(tracks: MediaStreamTrack[]) {
        capturedArgs.push(tracks);
      }
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);

    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onTrack(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.ontrack?.({ streams: [], track });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(capturedArgs).toEqual([[track]]);

    vi.unstubAllGlobals();
  });

  it("onConnectionType fires 'p2p' when both candidates are host type", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onConnectionType(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.statsEntries = [
      { type: "candidate-pair", id: "pair1", state: "succeeded", nominated: true, localCandidateId: "local1", remoteCandidateId: "remote1" },
      { type: "local-candidate", id: "local1", candidateType: "host" },
      { type: "remote-candidate", id: "remote1", candidateType: "host" },
    ];
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledWith("p2p");
  });

  it("onConnectionType fires 'relay' when local candidate is relay type", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onConnectionType(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.statsEntries = [
      { type: "candidate-pair", id: "pair1", state: "succeeded", nominated: true, localCandidateId: "local1", remoteCandidateId: "remote1" },
      { type: "local-candidate", id: "local1", candidateType: "relay" },
      { type: "remote-candidate", id: "remote1", candidateType: "host" },
    ];
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledWith("relay");
  });

  it("onConnectionType fires 'relay' when remote candidate is relay type", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onConnectionType(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.statsEntries = [
      { type: "candidate-pair", id: "pair1", state: "succeeded", nominated: true, localCandidateId: "local1", remoteCandidateId: "remote1" },
      { type: "local-candidate", id: "local1", candidateType: "srflx" },
      { type: "remote-candidate", id: "remote1", candidateType: "relay" },
    ];
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledWith("relay");
  });

  it("onConnectionType fires once when state changes multiple times with same type", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onConnectionType(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.statsEntries = [
      { type: "candidate-pair", id: "pair1", state: "succeeded", nominated: true, localCandidateId: "local1", remoteCandidateId: "remote1" },
      { type: "local-candidate", id: "local1", candidateType: "host" },
      { type: "remote-candidate", id: "remote1", candidateType: "host" },
    ];
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onConnectionType does not fire when state is not connected or completed", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onConnectionType(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.iceConnectionState = "checking";
    pc.oniceconnectionstatechange?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("ViewerPeer: remote ICE candidates that overtake the answer", () => {
  // The sharer relays candidates as soon as it gathers them, which can be
  // before its SDP answer is on the wire. addIceCandidate() before
  // setRemoteDescription() throws InvalidStateError in every browser, and the
  // viewer turned that into a hard "ICE-Fehler" teardown of an otherwise
  // healthy connect.
  it("queues candidates until the answer is applied, then adds them in order", async () => {
    const pc = new MockRTCPeerConnection();
    const added: string[] = [];
    let remoteSet = false;
    pc.setRemoteDescription = async () => { remoteSet = true; };
    pc.addIceCandidate = async (c: RTCIceCandidateInit) => {
      if (!remoteSet) throw new DOMException("no remote description", "InvalidStateError");
      added.push(c.candidate ?? "");
    };
    const peer = new ViewerPeer({ pcFactory: () => pc as unknown as RTCPeerConnection });
    await peer.start();

    await peer.addRemoteIceCandidate({ candidate: "candidate:1", sdpMid: "0" });
    await peer.addRemoteIceCandidate({ candidate: "candidate:2", sdpMid: "0" });
    expect(added).toEqual([]);

    await peer.acceptAnswer({ type: "answer", sdp: "v=0" });
    expect(added).toEqual(["candidate:1", "candidate:2"]);

    await peer.addRemoteIceCandidate({ candidate: "candidate:3", sdpMid: "0" });
    expect(added).toEqual(["candidate:1", "candidate:2", "candidate:3"]);
  });

  it("surfaces a failing queued candidate to the acceptAnswer caller", async () => {
    const pc = new MockRTCPeerConnection();
    pc.addIceCandidate = async () => { throw new Error("bad candidate"); };
    const peer = new ViewerPeer({ pcFactory: () => pc as unknown as RTCPeerConnection });
    await peer.start();
    await peer.addRemoteIceCandidate({ candidate: "candidate:x", sdpMid: "0" });
    await expect(peer.acceptAnswer({ type: "answer", sdp: "v=0" })).rejects.toThrow("bad candidate");
  });
});
