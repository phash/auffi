import { describe, it, expect, vi } from "vitest";
import { SignalingClient } from "../src/signaling-client.js";
import type { PwAttempt, ViewerJoin } from "../src/protocol.js";

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
    // `satisfies` pins the expected literal to the documented wire type —
    // a drift in either the frame or protocol.ts fails to compile.
    expect(JSON.parse(mock.sent[0])).toEqual({
      type: "join",
      role: "viewer",
      code: "284-915-073",
    } satisfies ViewerJoin);
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

  it("no double-disconnect after peer-confirmed then close", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const disconnectFn = vi.fn();
    client.onDisconnect(disconnectFn);
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
    // Simulate server closing connection after promise already resolved
    mock.onclose?.({});
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it("user-initiated close does not fire rejection listeners", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const disconnectFn = vi.fn();
    client.onDisconnect(disconnectFn);
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
    // User-initiated close
    client.close();
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  // ── gh #36: unattended-mode flow ────────────────────────────────────

  it("needs-password fires onNeedsPassword and keeps the promise unsettled", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const needsPw = vi.fn();
    client.onNeedsPassword(needsPw);
    const p = client.join("123-456-789");
    let settled: "yes" | "no" = "no";
    void p.then(() => (settled = "yes")).catch(() => (settled = "yes"));
    mock.fakeOpen();
    mock.fakeMessage({ type: "needs-password" });
    await new Promise((r) => setTimeout(r, 5));
    expect(needsPw).toHaveBeenCalledTimes(1);
    expect(settled).toBe("no");
    // Now confirm to settle the promise.
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
  });

  it("sendPwAttempt forwards a pw-attempt frame", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("123-456-789");
    mock.fakeOpen();
    mock.fakeMessage({ type: "needs-password" });
    client.sendPwAttempt("hunter2");
    expect(JSON.parse(mock.sent[1])).toEqual(
      { type: "pw-attempt", password: "hunter2" } satisfies PwAttempt,
    );
    // Resolve to keep the test clean.
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
  });

  it("wrong-password fires onWrongPassword with attemptsLeft, no settle", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const wrongPw = vi.fn();
    client.onWrongPassword(wrongPw);
    const p = client.join("123-456-789");
    let settled: "yes" | "no" = "no";
    void p.then(() => (settled = "yes")).catch(() => (settled = "yes"));
    mock.fakeOpen();
    mock.fakeMessage({ type: "needs-password" });
    mock.fakeMessage({ type: "wrong-password", attemptsLeft: 3 });
    await new Promise((r) => setTimeout(r, 5));
    expect(wrongPw).toHaveBeenCalledWith(3);
    expect(settled).toBe("no");
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
  });

  it("locked rejects the promise with code locked:N", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("123-456-789");
    mock.fakeOpen();
    mock.fakeMessage({ type: "locked", retryAfterSec: 850 });
    await expect(p).rejects.toThrow(/locked:850/);
  });

  it("rejected-by-user rejects the promise", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as unknown as WebSocket });
    const p = client.join("123-456-789");
    mock.fakeOpen();
    mock.fakeMessage({ type: "rejected-by-user" });
    await expect(p).rejects.toThrow(/rejected-by-user/);
  });
});
