import { describe, it, expect } from "vitest";
import { t } from "../src/i18n.js";
import { friendlyJoinError, connectTimeoutMessage } from "../src/connect-messages.js";

describe("t() catalog", () => {
  it("defaults to German (jsdom <html lang> is unset)", () => {
    expect(t("status.streamRunning")).toBe("Stream läuft.");
    expect(t("join.declined")).toBe("Der Sharer hat die Verbindung abgelehnt.");
  });

  it("returns English when lang='en'", () => {
    expect(t("status.streamRunning", {}, "en")).toBe("Stream is running.");
    expect(t("join.declined", {}, "en")).toBe("The other side declined the connection.");
  });

  it("interpolates params and pluralises per language", () => {
    expect(t("join.lockout", { mins: 3 }, "en")).toContain("3 min");
    expect(t("pw.wrong", { n: 1 }, "de")).toBe("Falsches Passwort. Noch 1 Versuch.");
    expect(t("pw.wrong", { n: 2 }, "de")).toBe("Falsches Passwort. Noch 2 Versuche.");
    expect(t("pw.wrong", { n: 1 }, "en")).toBe("Wrong password. 1 attempt left.");
    expect(t("pw.wrong", { n: 3 }, "en")).toBe("Wrong password. 3 attempts left.");
  });

  it("returns the key itself for an unknown key (never throws)", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
  });
});

describe("connect-messages honour the lang argument", () => {
  it("friendlyJoinError returns English copy when lang='en'", () => {
    expect(friendlyJoinError("peer-rejected: declined", "en").text).toBe("The other side declined the connection.");
    expect(friendlyJoinError("invalid-code: session full", "en").text.toLowerCase()).toContain("already connected");
    expect(friendlyJoinError("locked:120", "en").text).toContain("2 min");
    expect(friendlyJoinError("closed", "en").text.toLowerCase()).toContain("lost connection");
  });

  it("connectTimeoutMessage returns English copy when lang='en'", () => {
    expect(connectTimeoutMessage({ confirmed: false, relayAvailable: false }, "en").toLowerCase()).toContain("accepted");
    expect(connectTimeoutMessage({ confirmed: true, relayAvailable: true }, "en").toLowerCase()).toContain("picture");
    expect(connectTimeoutMessage({ confirmed: true, relayAvailable: false }, "en").toLowerCase()).toContain("firewall");
  });
});
