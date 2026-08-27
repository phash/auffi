import { describe, it, expect } from "vitest";
import {
  planStreamingStopped,
  streamingFailedMessage,
} from "../src/streaming-stopped-policy.js";

describe("planStreamingStopped", () => {
  it("viewer-swap (keepSignaling): leaves the join state and status alone", () => {
    expect(planStreamingStopped(true, false)).toEqual({
      resetSessionUi: false,
      showGenericStatus: false,
    });
    expect(planStreamingStopped(true, true)).toEqual({
      resetSessionUi: false,
      showGenericStatus: false,
    });
  });

  it("full teardown: resets the session UI and shows the generic status", () => {
    expect(planStreamingStopped(false, false)).toEqual({
      resetSessionUi: true,
      showGenericStatus: true,
    });
  });

  it("full teardown after a specific stop message: resets without clobbering the status", () => {
    expect(planStreamingStopped(false, true)).toEqual({
      resetSessionUi: true,
      showGenericStatus: false,
    });
  });
});

describe("streamingFailedMessage", () => {
  it("maps the Rust-side reasons to German copy", () => {
    expect(streamingFailedMessage("capture")).toContain("Bildschirmaufnahme");
    expect(streamingFailedMessage("track-write")).toContain("Verbindung zum Helfer");
    expect(streamingFailedMessage("internal")).toContain("Interner Fehler");
  });

  it("unknown reasons fall back to the internal-error copy instead of raw text", () => {
    expect(streamingFailedMessage("some-new-reason")).toContain("Interner Fehler");
  });
});
