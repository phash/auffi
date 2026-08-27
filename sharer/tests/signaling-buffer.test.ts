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

    await buffer.ready();
    expect(offers).toEqual(["v=0 offer"]);
    expect(ices.map((i) => i.candidate)).toEqual(["c1", "c2"]);
  });

  it("forwards immediately once ready", async () => {
    const { offers, ices, buffer } = harness();
    await buffer.ready();
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
    await buffer.ready();
    expect(offers).toEqual(["fresh offer"]);
  });

  it("reset drops buffers and ready-state so nothing leaks into the next session", async () => {
    const { offers, ices, buffer } = harness();
    buffer.offer("stale");
    buffer.ice({ candidate: "stale", sdpMid: "0" });
    buffer.reset();
    await buffer.ready();
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
    await buffer.ready();
    expect(buffer.hasActivity()).toBe(true);
  });
});
