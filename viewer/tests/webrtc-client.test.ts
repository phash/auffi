import { describe, it, expect, vi } from "vitest";
import { ViewerPeer } from "../src/webrtc-client.js";

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
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
  close(): void { this.iceConnectionState = "closed"; }
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
    pc.ontrack?.({ streams: [stream] });
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

  it("does not emit onTrack when track event has no streams", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onTrack(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.ontrack?.({ streams: [] });
    expect(handler).not.toHaveBeenCalled();
  });
});
