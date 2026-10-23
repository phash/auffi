import { describe, it, expect } from "vitest";
import { fileSendErrorMessage } from "../src/file-send-messages.js";

// pick_and_send_file now waits for the helper's Annehmen and fails with a
// stable code instead of a raw Rust string; every code needs German copy the
// sharer-user can act on.
describe("fileSendErrorMessage", () => {
  it("tells the user the helper declined", () => {
    expect(fileSendErrorMessage("file-rejected")).toBe("Der Helfer hat die Datei abgelehnt.");
  });

  it("explains an unanswered offer", () => {
    expect(fileSendErrorMessage("file-timeout")).toContain("nicht angenommen");
  });

  it("explains an ended session", () => {
    expect(fileSendErrorMessage("file-cancelled")).toContain("Verbindung");
    expect(fileSendErrorMessage("file-no-session")).toContain("Verbindung");
  });

  it("asks to wait while too many transfers run", () => {
    expect(fileSendErrorMessage("file-busy")).toContain("warte");
  });

  it("falls back to the generic copy for anything else, never echoing raw text", () => {
    expect(fileSendErrorMessage("file-failed")).toBe("Datei konnte nicht gesendet werden.");
    expect(fileSendErrorMessage(new Error("EACCES /home/x"))).toBe(
      "Datei konnte nicht gesendet werden.",
    );
    expect(fileSendErrorMessage(undefined)).toBe("Datei konnte nicht gesendet werden.");
  });
});
