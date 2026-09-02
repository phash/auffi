import { describe, it, expect } from "vitest";
import { friendlyDisconnectReason } from "../src/disconnect-reason.js";

// Every `reason` string the two Rust WS loops can emit today. signaling.rs
// (ad-hoc) and heartbeat.rs (unattended) both document the field as a
// dbg_log diagnostic, yet the webviews rendered it verbatim — "Getrennt:
// close code=1005 reason=\"\"" in a UI whose product goal is "no jargon".
const RAW_REASONS = [
  // signaling.rs
  'invalid origin "tauri://localhost": parse error',
  "invalid signaling url: relative URL without a base",
  "connect failed: IO error: Connection refused (os error 111)",
  "send failed on register",
  "serialize error: key must be a string",
  "send failed",
  'close code=1005 reason=""',
  "close without frame",
  "read: IO error: Connection reset by peer",
  "socket EOF",
  "no pong for 31s",
  "write half closed during ping",
  "rate-limit: message rate exceeded",
  "bad-message: unexpected message",
  "invalid-code: no such session",
  "expired",
  // heartbeat.rs
  "invalid ws url: empty host",
  "connect: IO error: Network is unreachable",
  "serialise outgoing: oops",
  "write half closed",
  "backend error rate-limit: too many registrations",
  "backend error bad-message: wait for unattended-hello before sending",
  "terminal close",
  "no pong for 90s",
];

describe("friendlyDisconnectReason", () => {
  it("never surfaces the raw protocol text", () => {
    for (const raw of RAW_REASONS) {
      const shown = friendlyDisconnectReason(raw);
      expect(shown, raw).not.toContain(raw);
      expect(shown, raw).not.toMatch(/code=|error|EOF|pong|socket|frame/i);
    }
  });

  it("is German copy ending in a full sentence", () => {
    for (const raw of RAW_REASONS) {
      expect(friendlyDisconnectReason(raw), raw).toMatch(/^[A-ZÄÖÜ].*\.$/);
    }
  });

  it("tells the user the server could not be reached on connect failures", () => {
    for (const raw of [
      "connect failed: IO error: Connection refused (os error 111)",
      "connect: IO error: Network is unreachable",
      "invalid signaling url: relative URL without a base",
    ]) {
      expect(friendlyDisconnectReason(raw), raw).toContain("nicht erreichbar");
    }
  });

  it("names the silent server on a pong timeout", () => {
    expect(friendlyDisconnectReason("no pong for 31s")).toContain("antwortet nicht");
  });

  it("asks for patience on a rate limit", () => {
    for (const raw of [
      "rate-limit: message rate exceeded",
      "backend error rate-limit: too many registrations",
    ]) {
      expect(friendlyDisconnectReason(raw), raw).toContain("kurz warten");
    }
  });

  it("falls back to a generic link-lost sentence for everything else", () => {
    for (const raw of ["socket EOF", 'close code=1005 reason=""', "some-new-reason", ""]) {
      expect(friendlyDisconnectReason(raw), raw).toBe("Verbindung zum Server getrennt.");
    }
  });
});
