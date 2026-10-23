// @vitest-environment jsdom
//
// Mounts index.html's body and imports main.ts with the four Tauri modules
// mocked, so the ad-hoc wiring (event listeners + button handlers) is driven
// end to end: emit a Tauri event, click a button, assert on the DOM and on
// the invoke() calls. This is the layer every session-lifecycle regression
// lived in; the pure policy modules alone could not catch a listener that
// forgot to call them.
import { describe, it, expect, beforeEach, vi } from "vitest";
import html from "../index.html?raw";

type Handler = (e: { payload: unknown }) => void | Promise<void>;

const { invokeMock, listeners, storeSet } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Handler[]>(),
  storeSet: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: () => Promise.resolve(undefined),
      set: storeSet,
    }),
}));

const INVOKE_RESULTS: Record<string, unknown> = {
  unattended_get_mode: "adhoc",
  capture_backend_uses_portal: true,
  list_monitors: [],
  get_debug_logging: false,
  check_for_update: { available: false, latest: "", download_url: "" },
  unattended_is_paired: null,
  unattended_is_password_set: false,
  unattended_is_active: false,
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function calls(cmd: string): unknown[][] {
  return invokeMock.mock.calls.filter((c: unknown[]) => c[0] === cmd);
}

async function emit(name: string, payload: unknown): Promise<void> {
  for (const h of listeners.get(name) ?? []) await h({ payload });
  await flush();
}

async function mount(overrides: Record<string, unknown> = {}): Promise<void> {
  const results = { ...INVOKE_RESULTS, ...overrides };
  listeners.clear();
  invokeMock.mockReset();
  storeSet.mockReset();
  storeSet.mockResolvedValue(undefined);
  invokeMock.mockImplementation((cmd: string) => Promise.resolve(results[cmd]));
  document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
  vi.resetModules();
  await import("../src/main.js");
  await flush();
  invokeMock.mockClear();
}

async function joinPeer(): Promise<void> {
  await emit("code-assigned", { code: "123456789", expiresInSec: 600 });
  await emit("peer-joined", { ipPrefix: "84.xxx", country: null });
}

/** Accept on the portal path and let the viewer's offer arrive — the stream is live. */
async function startStream(): Promise<void> {
  await joinPeer();
  byId<HTMLButtonElement>("accept").click();
  await flush();
  await emit("relay", { payload: { kind: "sdp", sdp: { type: "offer", sdp: "v=0" } } });
}

describe("main.ts ad-hoc wiring", () => {
  beforeEach(() => mount());

  // mode.txt says "unattended" but the device was never paired: nothing is
  // listening, so the main panel must not claim the mode is active.
  it("tells the truth about an unattended mode that is not ready", async () => {
    await mount({ unattended_get_mode: "unattended" });
    expect(calls("start_signaling")).toHaveLength(0);
    expect(byId("status").textContent).toContain("noch nicht gekoppelt");
    expect(byId("status").textContent).not.toMatch(/aktiv —/);
  });

  it("reports an active unattended heartbeat as active", async () => {
    await mount({
      unattended_get_mode: "unattended",
      unattended_is_paired: "dev-1",
      unattended_is_password_set: true,
      unattended_is_active: true,
    });
    expect(byId("status").textContent).toBe(
      "Unattended-Modus aktiv — Helfer verbinden sich über das Dashboard.",
    );
  });

  it("accepts a connection request exactly once however fast the user clicks", async () => {
    await joinPeer();
    const accept = byId<HTMLButtonElement>("accept");
    accept.click();
    accept.click();
    await flush();
    // Two confirm_peer round trips would run the start chain twice; on the
    // portal path that is two start_streaming calls and two portal dialogs,
    // which Plasma refuses to surface (docs/footguns.md § Sharer Teardown).
    expect(calls("confirm_peer")).toHaveLength(1);
    expect(calls("start_streaming")).toHaveLength(1);
  });

  it("shows the streaming controls once the accepted stream is live", async () => {
    await startStream();
    expect(byId("streaming-actions").classList.contains("visible")).toBe(true);
    expect(byId("status").textContent).toBe("Streaming läuft.");
  });

  // Backend-synthesized bye: an unconfirmed viewer closed its tab while the
  // request was up. The dialog closes, nothing is torn down, the code the
  // user just read aloud stays valid and its countdown resumes.
  it("dismisses a pending request on bye without releasing the code", async () => {
    await joinPeer();
    expect(byId("confirm").classList.contains("visible")).toBe(true);
    await emit("relay", { payload: { kind: "bye" } });
    expect(byId("confirm").classList.contains("visible")).toBe(false);
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(byId("code").textContent).toBe("123456789");
    expect(byId("code-expiry").textContent).toMatch(/^Gültig noch/);
    expect(byId("new-code-btn").classList.contains("visible")).toBe(true);
    expect(byId("status").textContent).toContain("Code bleibt gültig");
  });

  // Helper pressed Beenden mid-stream. The viewer keeps its lastCode for 30 s
  // to offer "doch nochmal verbinden" (gh #71) — that only works if the
  // sharer keeps its WS registration, i.e. keepSignaling.
  it("ends a live stream on bye but keeps the code redeemable", async () => {
    await startStream();
    await emit("relay", { payload: { kind: "bye" } });
    expect(calls("disconnect_streaming")).toEqual([["disconnect_streaming", { keepSignaling: true }]]);
    expect(byId("streaming-actions").classList.contains("visible")).toBe(false);
    expect(byId("code").textContent).toBe("123456789");
    expect(byId("status").textContent).toBe("Helfer hat die Verbindung beendet.");
    expect(byId("new-code-btn").classList.contains("visible")).toBe(true);
  });

  it("re-opens the request for the next helper joining on the kept code", async () => {
    await startStream();
    await emit("relay", { payload: { kind: "bye" } });
    invokeMock.mockClear();
    await emit("peer-joined", { ipPrefix: "91.xxx", country: "DE" });
    expect(byId("confirm").classList.contains("visible")).toBe(true);
    // The bye already tore the stream down — no second (swap) teardown.
    expect(calls("disconnect_streaming")).toHaveLength(0);
  });

  // Only the signaling WS died (backend restart, pong timeout); media and
  // remote input keep flowing P2P. Beenden must stay, "Neu verbinden" (a
  // full teardown) must not be offered, the released code must go.
  it("keeps Beenden when the signaling link dies mid-stream", async () => {
    await startStream();
    await emit("disconnected", { reason: "socket EOF" });
    expect(byId("streaming-actions").classList.contains("visible")).toBe(true);
    expect(byId("reconnect-btn-wrap").style.display).toBe("none");
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(byId("code").textContent).toBe("— — —");
    expect(byId("status").textContent).toContain("läuft weiter");
    expect(byId("status").textContent).not.toContain("EOF");
  });

  it("offers Neu verbinden when the signaling link dies before a stream", async () => {
    await joinPeer();
    await emit("disconnected", { reason: "no pong for 31s" });
    expect(byId("confirm").classList.contains("visible")).toBe(false);
    expect(byId("reconnect-btn-wrap").style.display).toBe("block");
    expect(byId("status").textContent).not.toContain("pong");
  });

  // ICE failed on a live stream: keepSignaling teardown whose
  // streaming-stopped event the listener ignores — the controls, banners and
  // relay label must be cleared here, and the still-valid code re-offered.
  it("clears the session controls and re-offers Neuer Code after ICE loss", async () => {
    await startStream();
    await emit("connection-type", "relay");
    await emit("input-paused-changed", { paused: true });
    await emit("ice-state", "failed");
    expect(calls("disconnect_streaming")).toEqual([["disconnect_streaming", { keepSignaling: true }]]);
    expect(byId("streaming-actions").classList.contains("visible")).toBe(false);
    expect(byId("pause-banner").classList.contains("visible")).toBe(false);
    expect(byId("connection-type-info").textContent).toBe("");
    expect(byId("new-code-btn").classList.contains("visible")).toBe(true);
    expect(byId("code-expiry").textContent).toMatch(/^Gültig noch/);
    expect(byId("status").textContent).toContain("Code bleibt gültig");
  });

  it("ignores a withdrawn request whose confirm_peer was still in flight", async () => {
    await joinPeer();
    let resolveConfirm: () => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "confirm_peer") return new Promise<void>((r) => (resolveConfirm = r));
      return Promise.resolve(INVOKE_RESULTS[cmd]);
    });
    byId<HTMLButtonElement>("accept").click();
    await emit("relay", { payload: { kind: "bye" } });
    resolveConfirm();
    await flush();
    // The helper left before the accept landed — no stream for nobody.
    expect(calls("start_streaming")).toHaveLength(0);
    expect(calls("list_monitors")).toHaveLength(0);
  });

  it("says plainly when the helper declined a file", async () => {
    await startStream();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pick_and_send_file" ? Promise.reject("file-rejected") : Promise.resolve(undefined),
    );
    byId<HTMLButtonElement>("send-file-btn").click();
    await flush();
    expect(byId("status").textContent).toBe("Der Helfer hat die Datei abgelehnt.");
    expect(byId("status").className).toBe("error");
  });

  it("stays quiet when the file picker is cancelled and confirms a sent file", async () => {
    await startStream();
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "pick_and_send_file" ? false : undefined),
    );
    byId<HTMLButtonElement>("send-file-btn").click();
    await flush();
    expect(byId("status").textContent).toBe("Streaming läuft.");

    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "pick_and_send_file" ? true : undefined),
    );
    byId<HTMLButtonElement>("send-file-btn").click();
    await flush();
    expect(byId("status").textContent).toBe("Datei wurde gesendet.");
  });
  // ── ICE grace vs. other teardowns (finding 14) ──────────────────────────
  // The 10 s grace armed on `disconnected` survived Beenden; it then fired
  // against whatever came next and tore down with keepSignaling.
  it("drops a pending ICE grace when the session ends another way", async () => {
    await startStream();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const h of listeners.get("ice-state") ?? []) await h({ payload: "disconnected" });
      byId<HTMLButtonElement>("stop-confirm-yes").click();
      invokeMock.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls("disconnect_streaming")).toHaveLength(0);
      expect(byId("status").textContent).toContain("Stream beendet");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── failures after Akzeptieren (finding 15) ─────────────────────────────
  it("offers Neuer Code when the portal start fails after Akzeptieren", async () => {
    await joinPeer();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "start_streaming"
        ? Promise.reject("portal cancelled")
        : Promise.resolve(INVOKE_RESULTS[cmd]),
    );
    byId<HTMLButtonElement>("accept").click();
    await flush();
    await flush();
    expect(byId("confirm").classList.contains("visible")).toBe(false);
    expect(byId("status").textContent).toContain("Streamen konnte nicht gestartet werden");
    expect(byId("status").className).toBe("error");
    expect(byId("new-code-btn").classList.contains("visible")).toBe(true);
  });

  it("offers Neuer Code when listing the monitors fails after Akzeptieren", async () => {
    await joinPeer();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "capture_backend_uses_portal") return Promise.resolve(false);
      if (cmd === "list_monitors") return Promise.reject("x11 gone");
      return Promise.resolve(INVOKE_RESULTS[cmd]);
    });
    byId<HTMLButtonElement>("accept").click();
    await flush();
    await flush();
    expect(byId("status").textContent).toContain("Streamen konnte nicht gestartet werden");
    expect(byId("new-code-btn").classList.contains("visible")).toBe(true);
    expect(byId("status").textContent).not.toContain("akzeptiert werden");
  });

  it("starts the stream even when remembering the helper fails", async () => {
    await joinPeer();
    storeSet.mockRejectedValue(new Error("store locked"));
    byId<HTMLInputElement>("remember-peer").checked = true;
    byId<HTMLButtonElement>("accept").click();
    await flush();
    await flush();
    expect(calls("start_streaming")).toHaveLength(1);
  });

  // ── heartbeat reconnect during a live unattended session (finding 17) ──
  it("keeps the main status while an unattended session is live", async () => {
    await mount({
      unattended_get_mode: "unattended",
      unattended_is_paired: "dev-1",
      unattended_is_password_set: true,
      unattended_is_active: true,
    });
    for (const h of listeners.get("ice-state") ?? []) await h({ payload: "disconnected" });
    expect(byId("status").textContent).toBe("Verbindung instabil …");
    window.dispatchEvent(
      new CustomEvent("auffi-unattended-state-changed", { detail: { sessionLive: true } }),
    );
    await flush();
    await flush();
    expect(byId("status").textContent).toBe("Verbindung instabil …");
  });

  // ── settings toggles roll back on failure (finding 18) ──────────────────
  it("rolls the large-code toggle back when it cannot be saved", async () => {
    storeSet.mockRejectedValue(new Error("disk full"));
    const toggle = byId<HTMLInputElement>("large-code-toggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(toggle.checked).toBe(false);
    expect(byId("code").style.fontSize).toBe("");
    expect(byId("status").className).toBe("error");
  });

  it("rolls the debug-log toggle back when Rust refuses it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_debug_logging" ? Promise.reject("nope") : Promise.resolve(undefined),
    );
    const toggle = byId<HTMLInputElement>("debug-log-toggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(toggle.checked).toBe(false);
    expect(storeSet).not.toHaveBeenCalledWith("debugLogging", true);
  });

  it("restores Rust's debug-log state when the store write fails", async () => {
    storeSet.mockRejectedValue(new Error("disk full"));
    const toggle = byId<HTMLInputElement>("debug-log-toggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    await flush();
    expect(toggle.checked).toBe(false);
    expect(calls("set_debug_logging")).toEqual([
      ["set_debug_logging", { enabled: true }],
      ["set_debug_logging", { enabled: false }],
    ]);
  });

  // ── file-offer dialog (finding 19) ──────────────────────────────────────
  it("focuses Ablehnen and queues a second offer instead of overwriting the first", async () => {
    await startStream();
    await emit("file-offer", { id: "a", name: "a.pdf", size: 10, mime: "application/pdf" });
    expect(document.activeElement).toBe(byId("file-offer-reject"));
    await emit("file-offer", { id: "b", name: "b.pdf", size: 20, mime: "application/pdf" });
    expect(byId("file-offer-text").textContent).toContain("a.pdf");

    byId<HTMLButtonElement>("file-offer-reject").click();
    await flush();
    expect(calls("reject_file")).toEqual([["reject_file", { id: "a" }]]);
    expect(byId("file-offer-dialog").classList.contains("visible")).toBe(true);
    expect(byId("file-offer-text").textContent).toContain("b.pdf");

    byId<HTMLButtonElement>("file-offer-accept").click();
    await flush();
    expect(calls("accept_file")).toEqual([["accept_file", { id: "b" }]]);
    expect(byId("file-offer-dialog").classList.contains("visible")).toBe(false);
  });

  it("drops open file offers when the session ends", async () => {
    await startStream();
    await emit("file-offer", { id: "a", name: "a.pdf", size: 10, mime: "application/pdf" });
    await emit("file-offer", { id: "b", name: "b.pdf", size: 20, mime: "application/pdf" });
    await emit("ice-state", "failed");
    expect(byId("file-offer-dialog").classList.contains("visible")).toBe(false);
    await startStream();
    await emit("file-offer", { id: "c", name: "c.pdf", size: 10, mime: "application/pdf" });
    expect(byId("file-offer-text").textContent).toContain("c.pdf");
  });
});
