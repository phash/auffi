import { describe, it, expect, vi } from "vitest";
import { SignalingClient } from "../src/signaling-client.js";

class MockWS {
  static OPEN = 1;
  readyState = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({}); }
  fakeOpen() { this.readyState = MockWS.OPEN; this.onopen?.({}); }
  fakeMessage(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe("SignalingClient", () => {
  it("sends join after connect", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
    expect(JSON.parse(mock.sent[0])).toEqual({
      type: "join",
      role: "viewer",
      code: "284-915-073",
    });
  });

  it("resolves connect promise on peer-confirmed", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects on invalid-code error", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("000-000-000");
    mock.fakeOpen();
    mock.fakeMessage({ type: "error", code: "invalid-code", message: "no such session" });
    await expect(p).rejects.toThrow(/invalid-code/);
  });

  it("emits relay events to listeners", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const fn = vi.fn();
    client.onRelay(fn);
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
    mock.fakeMessage({ type: "relay", payload: { hi: 1 } });
    expect(fn).toHaveBeenCalledWith({ hi: 1 });
  });
});
