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
vi.mock("@tauri-apps/plugin-shell", () => ({ open: () => Promise.resolve() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
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

async function mount(): Promise<void> {
  listeners.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => Promise.resolve(INVOKE_RESULTS[cmd]));
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
  beforeEach(mount);

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
});
