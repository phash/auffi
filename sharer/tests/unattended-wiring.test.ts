// @vitest-environment jsdom
//
// Mounts index.html's body and imports unattended.ts with the Tauri modules
// mocked — the Settings-panel wiring for the unattended flow (pair / password
// / activate / unpair buttons plus the `unattended-event` listener), driven
// end to end against the real DOM and the real in-app confirm dialog.
import { describe, it, expect, beforeEach, vi } from "vitest";
import html from "../index.html?raw";

type Handler = (e: { payload: unknown }) => void | Promise<void>;

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Handler[]>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  },
}));

const INVOKE_RESULTS: Record<string, unknown> = {
  unattended_get_mode: "unattended",
  unattended_is_paired: "dev-1234",
  unattended_is_password_set: true,
  unattended_is_active: true,
  autostart_is_enabled: false,
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function calls(cmd: string): unknown[][] {
  return invokeMock.mock.calls.filter((c: unknown[]) => c[0] === cmd);
}

function dialogButton(text: string): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("#sharer-confirm-backdrop button"),
  ).find((b) => b.textContent === text)!;
}

async function emit(payload: unknown): Promise<void> {
  for (const h of listeners.get("unattended-event") ?? []) await h({ payload });
  await flush();
}

async function mount(): Promise<void> {
  listeners.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => Promise.resolve(INVOKE_RESULTS[cmd]));
  document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
  document.head.innerHTML = html.slice(html.indexOf("<style>"), html.indexOf("</style>") + "</style>".length);
  vi.resetModules();
  await import("../src/unattended.js");
  await flush();
  invokeMock.mockClear();
}

/** Make start_streaming hang until the returned release() is called. */
function deferStart(): { release: () => void } {
  const pending: Array<() => void> = [];
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "start_streaming"
      ? new Promise<void>((r) => pending.push(r))
      : Promise.resolve(INVOKE_RESULTS[cmd]),
  );
  return { release: () => pending.shift()?.() };
}

function invokeOrder(...cmds: string[]): string[] {
  return invokeMock.mock.calls.map((c: unknown[]) => c[0] as string).filter((c) => cmds.includes(c));
}

/** A helper is connected and its offer has arrived — the P2P session is live. */
async function startSession(): Promise<void> {
  await emit({ kind: "peer-joined" });
  await emit({ kind: "relay", payload: { kind: "sdp", sdp: { type: "offer", sdp: "v=0" } } });
}

describe("unattended.ts settings wiring", () => {
  beforeEach(mount);

  it("starts the stream for a joining helper", async () => {
    await startSession();
    expect(calls("start_streaming")).toHaveLength(1);
    expect(calls("receive_offer")).toHaveLength(1);
  });

  // "Gerät entkoppeln" is the user's kill switch. unattended_stop only clears
  // the heartbeat's command slot and OutboundSink; an established P2P session
  // survives it — and because the heartbeat is shut down first, the backend's
  // revoke-closes-WSS path can never deliver the `revoked` event that would
  // otherwise tear the stream down. The helper kept screen and input.
  it("ends a live session before unpairing", async () => {
    await startSession();
    invokeMock.mockClear();
    byId<HTMLButtonElement>("unattended-unpair-btn").click();
    await flush();
    dialogButton("Entkoppeln").click();
    await flush();
    const order = invokeMock.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter((c) => ["disconnect_streaming", "unattended_stop", "unattended_unpair"].includes(c));
    expect(order).toEqual(["disconnect_streaming", "unattended_stop", "unattended_unpair"]);
    // The heartbeat owns its OutboundSink — every unattended teardown keeps it.
    // The heartbeat WSS survives (keepSignaling) but the helper still gets the
    // courteous bye — this is the sharer ending the session on purpose.
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true, sendBye: true }],
    ]);
  });

  it("routes the user's answer to the confirmId the prompt carried", async () => {
    await emit({ kind: "needs-confirm", confirmId: 7 });
    expect(document.getElementById("sharer-confirm-backdrop")).not.toBeNull();
    dialogButton("Erlauben").click();
    await flush();
    expect(calls("unattended_confirm")).toEqual([
      ["unattended_confirm", { confirmId: 7, accepted: true }],
    ]);
  });

  // The backend synthesizes the bye when the helper gives up pre-confirm
  // (tab closed, 2-minute pw-entry reap) precisely so the sharer's pending
  // prompt does not stand for a gone viewer; the webview only ever closed it
  // on the Rust-side 60 s timeout. Withdrawing must send NO answer: the
  // backend routes pw-check-result by sharer socket, so a Rejected fired now
  // could land on a newer helper's in-flight check.
  it("withdraws the open access prompt on bye without answering it", async () => {
    await emit({ kind: "needs-confirm", confirmId: 7 });
    await emit({ kind: "relay", payload: { kind: "bye" } });
    expect(document.getElementById("sharer-confirm-backdrop")).toBeNull();
    expect(calls("unattended_confirm")).toHaveLength(0);
    expect(byId("unattended-status").textContent).toContain("zurückgezogen");
  });

  it("still answers a prompt the user decides on after an unrelated bye", async () => {
    await emit({ kind: "relay", payload: { kind: "bye" } });
    await emit({ kind: "needs-confirm", confirmId: 8 });
    dialogButton("Ablehnen").click();
    await flush();
    expect(calls("unattended_confirm")).toEqual([
      ["unattended_confirm", { confirmId: 8, accepted: false }],
    ]);
  });

  // The eye-toggle button is absolutely positioned inside the input's right
  // edge; the input carried an inline `padding: 0.5rem`, which beats every
  // stylesheet selector, so the last typed characters ran under the button.
  it("keeps the typed password clear of the eye-toggle button", () => {
    const input = byId<HTMLInputElement>("unattended-pw-input");
    expect(input.parentElement?.classList.contains("password-wrap")).toBe(true);
    // 2.625rem at jsdom's 16px root — wider than the 2.25rem (36px) button.
    expect(getComputedStyle(input).paddingRight).toBe("42px");
  });

  it("unpairs without a teardown when nothing was streaming", async () => {
    byId<HTMLButtonElement>("unattended-unpair-btn").click();
    await flush();
    dialogButton("Entkoppeln").click();
    await flush();
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(calls("unattended_unpair")).toHaveLength(1);
  });

  // The P2P session survives a heartbeat blip, but the reconnect's
  // disconnected → reconnecting → connected events rewrote "Helfer
  // verbunden" to "Verbunden" while the helper was still on screen.
  it("keeps the session status through a heartbeat reconnect", async () => {
    await startSession();
    expect(byId("unattended-status").textContent).toBe("Helfer verbunden");
    const changes: unknown[] = [];
    window.addEventListener("auffi-unattended-state-changed", (e) =>
      changes.push((e as CustomEvent).detail),
    );
    await emit({ kind: "disconnected" });
    await emit({ kind: "reconnecting", after_ms: 2000, attempt: 1 });
    await emit({ kind: "connected", deviceId: "dev-1234" });
    expect(byId("unattended-status").textContent).toBe("Helfer verbunden");
    expect(changes.at(-1)).toEqual({ sessionLive: true });
  });

  it("reports heartbeat state normally when no session is live", async () => {
    await emit({ kind: "disconnected" });
    expect(byId("unattended-status").textContent).toContain("Getrennt");
    await emit({ kind: "connected", deviceId: "dev-1234" });
    expect(byId("unattended-status").textContent).toBe("Verbunden");
  });

  // ── terminal + expiry branches ──────────────────────────────────────────
  it("tears a live session down when the device is revoked", async () => {
    await startSession();
    invokeMock.mockClear();
    await emit({ kind: "revoked" });
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true }],
    ]);
    expect(byId("unattended-status").textContent).toContain("Sitzung beendet");
  });

  it("only reports a takeover when nothing was streaming", async () => {
    await emit({ kind: "superseded" });
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(byId("unattended-status").textContent).toBe("Eine andere Instanz hat übernommen.");
  });

  it("closes the prompt whose confirmation expired", async () => {
    await emit({ kind: "needs-confirm", confirmId: 7 });
    await emit({ kind: "confirm-expired", confirmId: 7 });
    expect(document.getElementById("sharer-confirm-backdrop")).toBeNull();
    expect(byId("unattended-status").textContent).toContain("abgelaufen");
  });

  it("keeps a prompt open when another confirmation expires", async () => {
    await emit({ kind: "needs-confirm", confirmId: 7 });
    await emit({ kind: "confirm-expired", confirmId: 6 });
    expect(document.getElementById("sharer-confirm-backdrop")).not.toBeNull();
  });

  it("declines the prompt a newer one displaces", async () => {
    await emit({ kind: "needs-confirm", confirmId: 1 });
    await emit({ kind: "needs-confirm", confirmId: 2 });
    expect(calls("unattended_confirm")).toEqual([
      ["unattended_confirm", { confirmId: 1, accepted: false }],
    ]);
  });

  it("ends a live session with a bye before Deaktivieren stops the heartbeat", async () => {
    await startSession();
    invokeMock.mockClear();
    byId<HTMLButtonElement>("unattended-stop-btn").click();
    await flush();
    expect(invokeOrder("disconnect_streaming", "unattended_stop")).toEqual([
      "disconnect_streaming",
      "unattended_stop",
    ]);
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true, sendBye: true }],
    ]);
  });

  it("starts the next helper without a teardown after a failed stream", async () => {
    await startSession();
    for (const h of listeners.get("streaming-failed") ?? []) await h({ payload: { reason: "x" } });
    invokeMock.mockClear();
    await emit({ kind: "peer-joined" });
    expect(invokeOrder("disconnect_streaming", "start_streaming")).toEqual(["start_streaming"]);
  });

  // ── a start that a teardown overtakes ───────────────────────────────────
  // start_streaming cannot be cancelled and Rust stores the peer only at its
  // end: a revoke while it runs finds nothing to tear down, and the late
  // start kept capture and input alive after the owner revoked the device.
  it("tears down a start that a revoke overtook", async () => {
    const start = deferStart();
    await emit({ kind: "peer-joined" });
    await emit({ kind: "revoked" });
    invokeMock.mockClear();
    start.release();
    await flush();
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true }],
    ]);
  });

  it("ends a start still in flight when the user deactivates", async () => {
    const start = deferStart();
    await emit({ kind: "peer-joined" });
    byId<HTMLButtonElement>("unattended-stop-btn").click();
    await flush();
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true, sendBye: true }],
    ]);
    invokeMock.mockClear();
    start.release();
    await flush();
    expect(calls("disconnect_streaming")).toEqual([
      ["disconnect_streaming", { keepSignaling: true }],
    ]);
  });

  // Rust's rtc_state guard runs before the slow steps, so two overlapping
  // starts both pass it.
  it("runs a second helper's start only after the first one settled", async () => {
    const start = deferStart();
    await emit({ kind: "peer-joined" });
    await emit({ kind: "peer-joined" });
    expect(calls("start_streaming")).toHaveLength(1);
    start.release();
    await flush();
    await flush();
    expect(calls("start_streaming")).toHaveLength(2);
    expect(invokeOrder("disconnect_streaming", "start_streaming")).toEqual([
      "start_streaming",
      "disconnect_streaming",
      "start_streaming",
    ]);
  });

  // main.ts owns the ice-state teardown; the backend sends no bye for a
  // confirmed session that died, so without the event this buffer stayed
  // live and every heartbeat line was suppressed indefinitely.
  it("returns to the heartbeat status after an ICE-loss teardown", async () => {
    await startSession();
    const changes: unknown[] = [];
    window.addEventListener("auffi-unattended-state-changed", (e) =>
      changes.push((e as CustomEvent).detail),
    );
    window.dispatchEvent(new Event("auffi-stream-ended-after-ice-loss"));
    await flush();
    expect(byId("unattended-status").textContent).toContain("Verbindung zum Helfer verloren");
    expect(changes.at(-1)).toEqual({ sessionLive: false });
    await emit({ kind: "reconnecting", after_ms: 2000, attempt: 1 });
    expect(byId("unattended-status").textContent).toContain("Neuer Verbindungsversuch");
  });
});
