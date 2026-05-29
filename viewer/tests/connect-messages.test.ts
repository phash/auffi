import { describe, it, expect } from "vitest";
import { friendlyJoinError, connectTimeoutMessage } from "../src/connect-messages.js";

describe("friendlyJoinError", () => {
  it("maps an unattended lockout to a German message with the wait in minutes", () => {
    const r = friendlyJoinError("locked:120");
    expect(r.kind).toBe("err");
    expect(r.text).toContain("2 Min");
    expect(r.text.toLowerCase()).toContain("fehlversuche");
  });

  it("rounds the lockout up and never below one minute", () => {
    expect(friendlyJoinError("locked:30").text).toContain("1 Min");
    expect(friendlyJoinError("locked:0").text).toContain("1 Min");
    expect(friendlyJoinError("locked:90").text).toContain("2 Min");
  });

  it("treats an unattended user-decline as an informational rejection", () => {
    const r = friendlyJoinError("rejected-by-user");
    expect(r.kind).toBe("info");
    expect(r.text).toBe("Der Sharer hat die Verbindung abgelehnt.");
  });

  it("maps a peer-rejected:declined to the same friendly decline", () => {
    const r = friendlyJoinError("peer-rejected: declined");
    expect(r.kind).toBe("info");
    expect(r.text).toBe("Der Sharer hat die Verbindung abgelehnt.");
  });

  it("explains a sharer-gone rejection with a path forward", () => {
    const r = friendlyJoinError("peer-rejected: sharer-gone");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("nicht mehr erreichbar");
  });

  it("treats an expired peer-rejection like an expired code", () => {
    const r = friendlyJoinError("peer-rejected: expired");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toMatch(/abgelaufen|neuen code/);
  });

  it("maps an unknown/wrong code to a clear 'nicht gültig' message", () => {
    const r = friendlyJoinError("invalid-code: no such session");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("nicht (mehr) gültig");
  });

  it("distinguishes a full session from a wrong code", () => {
    const r = friendlyJoinError("invalid-code: session full");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("bereits");
  });

  it("maps a burned code (code-expired) to a 'too many attempts' message", () => {
    const r = friendlyJoinError("code-expired: code burned after too many attempts");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toMatch(/gesperrt|fehlversuchen/);
  });

  it("maps rate-limit to a 'kurz warten' message", () => {
    const r = friendlyJoinError("rate-limit: too many attempts");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("zu viele versuche");
  });

  it("maps a protocol bad-message to a reload hint", () => {
    const r = friendlyJoinError("bad-message: invalid JSON");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("neu laden");
  });

  it("maps a pre-confirmation socket close to a 'server verloren' message", () => {
    const r = friendlyJoinError("closed");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("verbindung zum server verloren");
  });

  it("falls back to a generic German message for anything unrecognised", () => {
    const r = friendlyJoinError("totally-unexpected-thing");
    expect(r.kind).toBe("err");
    expect(r.text.toLowerCase()).toContain("verbindung fehlgeschlagen");
    // Never leak the raw token to the non-technical helper.
    expect(r.text).not.toContain("totally-unexpected-thing");
  });
});

describe("connectTimeoutMessage", () => {
  it("blames a missing sharer-confirmation before the peer is confirmed", () => {
    const before = connectTimeoutMessage({ confirmed: false, relayAvailable: false });
    expect(before.toLowerCase()).toContain("bestätigt");
    // relay availability is irrelevant while still waiting for confirmation
    expect(connectTimeoutMessage({ confirmed: false, relayAvailable: true })).toBe(before);
  });

  it("reports a media stall when confirmed and relay was available", () => {
    const r = connectTimeoutMessage({ confirmed: true, relayAvailable: true });
    expect(r.toLowerCase()).toContain("bild");
  });

  it("hints at a firewall when confirmed but no relay was reachable", () => {
    const r = connectTimeoutMessage({ confirmed: true, relayAvailable: false });
    expect(r.toLowerCase()).toContain("firewall");
  });
});
