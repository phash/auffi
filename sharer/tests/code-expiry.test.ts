import { describe, it, expect } from "vitest";
import { formatExpiry, remainingSeconds } from "../src/code-expiry.js";

describe("formatExpiry", () => {
  it("formats remaining time as M:SS with a German prefix", () => {
    expect(formatExpiry(598)).toEqual({ expired: false, label: "Gültig noch 9:58" });
    expect(formatExpiry(600)).toEqual({ expired: false, label: "Gültig noch 10:00" });
    expect(formatExpiry(65)).toEqual({ expired: false, label: "Gültig noch 1:05" });
  });

  it("zero-pads the seconds below ten", () => {
    expect(formatExpiry(9)).toEqual({ expired: false, label: "Gültig noch 0:09" });
    expect(formatExpiry(1)).toEqual({ expired: false, label: "Gültig noch 0:01" });
  });

  it("marks the code expired at or below zero", () => {
    expect(formatExpiry(0)).toEqual({ expired: true, label: "Code abgelaufen" });
    expect(formatExpiry(-5)).toEqual({ expired: true, label: "Code abgelaufen" });
  });

  it("floors fractional seconds", () => {
    expect(formatExpiry(65.9)).toEqual({ expired: false, label: "Gültig noch 1:05" });
  });
});

// peer-joined pauses the countdown for the handshake; when the helper leaves
// again (bye, ICE loss) the code is still valid server-side and the countdown
// must resume from the original deadline — not restart at 10:00.
describe("remainingSeconds", () => {
  it("rounds up to the next whole second so the label never under-reports", () => {
    const now = 1_000_000;
    expect(remainingSeconds(now + 65_400, now)).toBe(66);
    expect(remainingSeconds(now + 60_000, now)).toBe(60);
  });

  it("clamps a passed deadline to zero", () => {
    const now = 1_000_000;
    expect(remainingSeconds(now - 1, now)).toBe(0);
    expect(remainingSeconds(now, now)).toBe(0);
  });
});
