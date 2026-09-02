import { describe, it, expect } from "vitest";
import {
  planStreamingStopped,
  streamingFailedMessage,
} from "../src/streaming-stopped-policy.js";

describe("planStreamingStopped", () => {
  it("viewer-swap (keepSignaling): leaves the join state and status alone", () => {
    // The peer-joined handler has just opened the confirm dialog for the NEW
    // helper — dismissing it here would kill that request.
    expect(planStreamingStopped(true, false)).toEqual({
      resetSessionUi: false,
      showGenericStatus: false,
      dismissConnectionRequest: false,
    });
    expect(planStreamingStopped(true, true)).toEqual({
      resetSessionUi: false,
      showGenericStatus: false,
      dismissConnectionRequest: false,
    });
  });

  it("full teardown: resets the session UI and shows the generic status", () => {
    expect(planStreamingStopped(false, false)).toEqual({
      resetSessionUi: true,
      showGenericStatus: true,
      dismissConnectionRequest: true,
    });
  });

  it("full teardown after a specific stop message: resets without clobbering the status", () => {
    expect(planStreamingStopped(false, true)).toEqual({
      resetSessionUi: true,
      showGenericStatus: false,
      dismissConnectionRequest: true,
    });
  });

  it("full teardown dismisses a pending Verbindungsanfrage — its channel is gone", () => {
    // confirm_peer against a dropped SignalingState can only fail with
    // "signaling not started"; a dialog nobody can answer must not stand.
    for (const specific of [true, false]) {
      expect(planStreamingStopped(false, specific).dismissConnectionRequest).toBe(true);
    }
  });
});

describe("streamingFailedMessage", () => {
  it("maps the Rust-side reasons to German copy", () => {
    expect(streamingFailedMessage("capture")).toContain("Bildschirmaufnahme");
    expect(streamingFailedMessage("track-write")).toContain("Verbindung zum Helfer");
    expect(streamingFailedMessage("internal")).toContain("Interner Fehler");
  });

  it("names the encoder giving up so the user knows the picture, not the link, failed", () => {
    expect(streamingFailedMessage("encode")).toMatch(/Übertragung wurde beendet/);
    expect(streamingFailedMessage("encode")).not.toBe(streamingFailedMessage("unknown"));
  });

  it("unknown reasons fall back to the internal-error copy instead of raw text", () => {
    expect(streamingFailedMessage("some-new-reason")).toContain("Interner Fehler");
  });
});
