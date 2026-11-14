import { describe, it, expect } from "vitest";
import {
  SignalingBuffer,
  normalizeIceCandidate,
  type IcePayload,
} from "../src/signaling-buffer.js";

function harness() {
  const offers: string[] = [];
  const ices: IcePayload[] = [];
  const buffer = new SignalingBuffer({
    sendOffer: async (sdp) => {
      offers.push(sdp);
    },
    sendIce: async (ice) => {
      ices.push(ice);
    },
  });
  return { offers, ices, buffer };
}

describe("normalizeIceCandidate", () => {
  it("maps the wire key sdpMLineIndex to Tauri's sdpMlineIndex", () => {
    // The wire/browser key has a capital L; Tauri derives sdpMlineIndex
    // (lowercase l) from the Rust arg sdp_mline_index. Passing the wire
    // object through unmapped makes Rust deserialize the index as None
    // on every candidate — this pin is the whole point of the helper.
    const out = normalizeIceCandidate({
      candidate: "candidate:0 1 UDP",
      sdpMid: "0",
      sdpMLineIndex: 2,
      usernameFragment: "frag",
    });
    expect(out).toEqual({
      candidate: "candidate:0 1 UDP",
      sdpMid: "0",
      sdpMlineIndex: 2,
      usernameFragment: "frag",
    });
    expect("sdpMLineIndex" in out).toBe(false);
  });

  it("fills absent fields with empty string / null", () => {
    expect(normalizeIceCandidate({})).toEqual({
      candidate: "",
      sdpMid: null,
      sdpMlineIndex: null,
      usernameFragment: null,
    });
  });
});

describe("SignalingBuffer", () => {
  it("buffers offer and ICE until ready, then replays offer-first in order", async () => {
    const { offers, ices, buffer } = harness();
    buffer.ice({ candidate: "c1", sdpMid: "0" });
    buffer.offer("v=0 offer");
    buffer.ice({ candidate: "c2", sdpMid: "0" });
    expect(offers).toEqual([]);
    expect(ices).toEqual([]);

    await buffer.ready(buffer.generation);
    expect(offers).toEqual(["v=0 offer"]);
    expect(ices.map((i) => i.candidate)).toEqual(["c1", "c2"]);
  });

  it("forwards immediately once ready", async () => {
    const { offers, ices, buffer } = harness();
    await buffer.ready(buffer.generation);
    buffer.offer("live offer");
    buffer.ice({ candidate: "live", sdpMid: "0" });
    // sinks are called via fire-and-forget promises — flush microtasks.
    await Promise.resolve();
    expect(offers).toEqual(["live offer"]);
    expect(ices.map((i) => i.candidate)).toEqual(["live"]);
  });

  it("a newer buffered offer replaces the older one", async () => {
    const { offers, buffer } = harness();
    buffer.offer("stale offer");
    buffer.offer("fresh offer");
    await buffer.ready(buffer.generation);
    expect(offers).toEqual(["fresh offer"]);
  });

  it("reset drops buffers and ready-state so nothing leaks into the next session", async () => {
    const { offers, ices, buffer } = harness();
    buffer.offer("stale");
    buffer.ice({ candidate: "stale", sdpMid: "0" });
    buffer.reset();
    await buffer.ready(buffer.generation);
    expect(offers).toEqual([]);
    expect(ices).toEqual([]);

    buffer.reset();
    // After reset, incoming material buffers again instead of hitting
    // the (torn-down) peer.
    buffer.offer("next-session offer");
    expect(offers).toEqual([]);
    expect(buffer.hasActivity()).toBe(true);
  });

  it("hasActivity reflects live session, buffered material, and reset", async () => {
    const { buffer } = harness();
    expect(buffer.hasActivity()).toBe(false);
    buffer.ice({ candidate: "c", sdpMid: "0" });
    expect(buffer.hasActivity()).toBe(true);
    buffer.reset();
    expect(buffer.hasActivity()).toBe(false);
    await buffer.ready(buffer.generation);
    expect(buffer.hasActivity()).toBe(true);
  });

  // A teardown that lands while start_streaming is still pending (portal
  // dialog open, TURN fetch) must win: the late start may not flip the
  // buffer live for a session that has already ended.
  it("a ready() for a generation that reset() retired stays not-live", async () => {
    const { offers, buffer } = harness();
    const gen = buffer.generation;
    buffer.offer("old session");
    buffer.reset();
    expect(await buffer.ready(gen)).toBe(false);
    expect(buffer.hasActivity()).toBe(false);
    buffer.offer("next session");
    expect(offers).toEqual([]);
  });

  it("ready() for the current generation reports live", async () => {
    const { buffer } = harness();
    expect(await buffer.ready(buffer.generation)).toBe(true);
    expect(buffer.isCurrent(buffer.generation)).toBe(true);
  });

  it("stops replaying old candidates once reset() runs mid-replay", async () => {
    const ices: IcePayload[] = [];
    const buffer: SignalingBuffer = new SignalingBuffer({
      sendOffer: async () => {},
      sendIce: async (ice) => {
        ices.push(ice);
        buffer.reset();
      },
    });
    buffer.ice({ candidate: "c1", sdpMid: "0" });
    buffer.ice({ candidate: "c2", sdpMid: "0" });
    expect(await buffer.ready(buffer.generation)).toBe(false);
    expect(ices.map((i) => i.candidate)).toEqual(["c1"]);
  });

  it("keeps the next session's candidates when reset() runs during the offer replay", async () => {
    const ices: string[] = [];
    let resetDuringOffer = true;
    const buffer: SignalingBuffer = new SignalingBuffer({
      sendOffer: async () => {
        if (!resetDuringOffer) return;
        resetDuringOffer = false;
        buffer.reset();
        buffer.ice({ candidate: "next", sdpMid: "0" });
      },
      sendIce: async (ice) => {
        ices.push(ice.candidate);
      },
    });
    buffer.offer("v=0");
    expect(await buffer.ready(buffer.generation)).toBe(false);
    expect(ices).toEqual([]);
    expect(await buffer.ready(buffer.generation)).toBe(true);
    expect(ices).toEqual(["next"]);
  });
});
