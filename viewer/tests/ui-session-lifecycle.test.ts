import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, flush, type MockPC } from "./helpers/ui-session.js";

function status(): string {
  return document.getElementById("status")!.textContent ?? "";
}

function p2pStats(): RTCStatsReport {
  return new Map<string, Record<string, unknown>>([
    ["pair", { type: "candidate-pair", id: "pair", state: "succeeded", nominated: true, localCandidateId: "l", remoteCandidateId: "r" }],
    ["l", { type: "local-candidate", id: "l", candidateType: "host" }],
    ["r", { type: "remote-candidate", id: "r", candidateType: "srflx" }],
  ]) as unknown as RTCStatsReport;
}

async function liveP2pSession(): Promise<MockPC> {
  const session = await startUiSession();
  const pc = await session.confirm();
  session.track(pc);
  (document.getElementById("remote-video") as HTMLVideoElement).dispatchEvent(new Event("playing"));
  pc.getStats = async () => p2pStats();
  pc.fireIceState("connected");
  await session.openChannels(pc);
  return pc;
}

function chunkFrame(id: string, payload: number[]): ArrayBuffer {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const buf = new ArrayBuffer(8 + payload.length);
  new DataView(buf).setUint32(0, hash >>> 0, true);
  new Uint8Array(buf, 8).set(payload);
  return buf;
}

describe("session summary after a live session", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists duration, connection type and received files, and closes on ×", async () => {
    const pc = await liveP2pSession();
    expect(document.getElementById("connection-type")!.textContent).toBe("Direkt");
    const files = pc.channel("files");
    files.fakeMessage(JSON.stringify({ kind: "file-offer", id: "f", name: "notiz.txt", size: 2, mime: "text/plain" }));
    await flush();
    (document.getElementById("file-offer-accept") as HTMLButtonElement).click();
    await flush();
    files.fakeMessage(chunkFrame("f", [1, 2]));
    files.fakeMessage(JSON.stringify({ kind: "file-done", id: "f" }));
    await flush();

    (document.getElementById("disconnect") as HTMLButtonElement).click();

    const summary = document.getElementById("session-summary")!;
    expect(summary.hidden).toBe(false);
    expect(document.getElementById("session-summary-duration")!.textContent).toMatch(/^\d/);
    expect(document.getElementById("session-summary-conn")!.textContent).toBe("Direkt (peer-to-peer)");
    expect(document.getElementById("session-summary-files-wrap")!.hidden).toBe(false);
    expect(document.getElementById("session-summary-files")!.textContent).toBe("notiz.txt — 2 B");

    (document.getElementById("session-summary-close") as HTMLButtonElement).click();
    expect(summary.hidden).toBe(true);
  });

  it("hides the file list when nothing was received and dismisses itself after 30 s", async () => {
    vi.useFakeTimers();
    await liveP2pSession();
    (document.getElementById("disconnect") as HTMLButtonElement).click();
    const summary = document.getElementById("session-summary")!;
    expect(summary.hidden).toBe(false);
    expect(document.getElementById("session-summary-files-wrap")!.hidden).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(summary.hidden).toBe(true);
  });

  it("shows nothing for a connect that never got a frame", async () => {
    await startUiSession();
    (document.getElementById("cancel-connect") as HTMLButtonElement).click();
    expect(document.getElementById("session-summary")!.hidden).toBe(true);
  });
});

describe("join failures reach the helper as plain German", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an unknown code", async () => {
    const session = await startUiSession();
    session.ws.fakeMessage({ type: "error", code: "invalid-code", message: "no such session" });
    await flush();
    expect(status()).toBe("Dieser Code ist nicht (mehr) gültig. Bitte beim Helfer nach einem aktuellen Code fragen.");
    expect(document.getElementById("status")!.className).toBe("err");
    expect((document.getElementById("connect") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("reconnect-wrap")!.classList.contains("active")).toBe(true);
  });

  it("the other side declines", async () => {
    const session = await startUiSession();
    session.ws.fakeMessage({ type: "peer-rejected", reason: "declined" });
    await flush();
    expect(status()).toBe("Die andere Seite hat die Verbindung abgelehnt.");
    expect(document.getElementById("status")!.className).toBe("info");
  });

  it("a malformed code never opens a connection", async () => {
    await startUiSession();
    const { MockWS } = await import("./helpers/ui-session.js");
    const before = MockWS.instances.length;
    (document.getElementById("cancel-connect") as HTMLButtonElement).click();
    (document.getElementById("code") as HTMLInputElement).value = "12-34";
    (document.getElementById("connect") as HTMLButtonElement).click();
    await flush();
    expect(status()).toBe("Bitte 9-stelligen Code eingeben.");
    expect(MockWS.instances.length).toBe(before);
  });

  it("Enter in the code field connects like the button", async () => {
    await startUiSession();
    const { MockWS } = await import("./helpers/ui-session.js");
    (document.getElementById("cancel-connect") as HTMLButtonElement).click();
    const before = MockWS.instances.length;
    const input = document.getElementById("code") as HTMLInputElement;
    input.value = "987654321";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("987-654-321");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await flush();
    expect(MockWS.instances.length).toBe(before + 1);
  });

  it("Neu verbinden reuses the last code", async () => {
    const session = await startUiSession("111-222-333");
    session.ws.fakeMessage({ type: "peer-rejected", reason: "declined" });
    await flush();
    const { MockWS } = await import("./helpers/ui-session.js");
    (document.getElementById("reconnect-btn") as HTMLButtonElement).click();
    await flush();
    const next = MockWS.instances.at(-1)!;
    expect(next).not.toBe(session.ws);
    next.fakeOpen();
    await flush();
    expect(next.sentOfType("join")[0]).toMatchObject({ code: "111-222-333" });
    expect(document.getElementById("reconnect-wrap")!.classList.contains("active")).toBe(false);
  });

  it("the outgoing local ICE candidates are relayed to the sharer", async () => {
    const session = await startUiSession();
    const pc = await session.confirm();
    pc.onicecandidate?.({
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "u" } as RTCIceCandidate,
    });
    pc.onicecandidate?.({ candidate: null });
    const ice = session.ws.sentOfType("relay").filter((m) => (m.payload as { kind: string }).kind === "ice");
    expect(ice).toHaveLength(1);
  });
});

describe("password prompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Abbrechen closes the prompt and ends the attempt", async () => {
    const session = await startUiSession();
    session.ws.fakeMessage({ type: "needs-password" });
    await flush();
    const toast = document.getElementById("pw-prompt-toast")!;
    expect(toast.classList.contains("active")).toBe(true);

    (document.getElementById("pw-prompt-cancel") as HTMLButtonElement).click();
    expect(toast.classList.contains("active")).toBe(false);
    expect(status()).toBe("Vom Helfer abgebrochen.");
    expect(session.ws.readyState).toBe(3);
  });

  it("an empty password is not sent", async () => {
    const session = await startUiSession();
    session.ws.fakeMessage({ type: "needs-password" });
    await flush();
    (document.getElementById("pw-prompt-submit") as HTMLButtonElement).click();
    expect(session.ws.sentOfType("pw-attempt")).toEqual([]);
  });
});
