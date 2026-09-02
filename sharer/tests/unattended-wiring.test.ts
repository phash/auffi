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

  it("unpairs without a teardown when nothing was streaming", async () => {
    byId<HTMLButtonElement>("unattended-unpair-btn").click();
    await flush();
    dialogButton("Entkoppeln").click();
    await flush();
    expect(calls("disconnect_streaming")).toHaveLength(0);
    expect(calls("unattended_unpair")).toHaveLength(1);
  });
});
