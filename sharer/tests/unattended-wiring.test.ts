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
  vi.resetModules();
  await import("../src/unattended.js");
  await flush();
  invokeMock.mockClear();
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
    expect(calls("disconnect_streaming")).toEqual([["disconnect_streaming", { keepSignaling: true }]]);
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

  it("unpairs without a teardown when nothing was streaming", async () => {
    byId<HTMLButtonElement>("unattended-unpair-btn").click();
    await flush();
    dialogButton("Entkoppeln").click();
    await flush();
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(calls("unattended_unpair")).toHaveLength(1);
  });
});
