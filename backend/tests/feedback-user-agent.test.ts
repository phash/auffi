import { describe, it, expect } from "vitest";
import { truncateUserAgent } from "../src/feedback/user_agent.js";

describe("truncateUserAgent", () => {
  it("returns 'unknown' for empty / null / undefined", () => {
    expect(truncateUserAgent("")).toBe("unknown");
    expect(truncateUserAgent(undefined)).toBe("unknown");
    expect(truncateUserAgent(null)).toBe("unknown");
  });

  it("identifies Chrome on Linux", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    expect(truncateUserAgent(ua)).toBe("Chrome/Linux");
  });

  it("identifies Firefox on Windows", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
    expect(truncateUserAgent(ua)).toBe("Firefox/Windows");
  });

  it("identifies Safari on macOS (Chrome substring absent)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(truncateUserAgent(ua)).toBe("Safari/macOS");
  });

  it("identifies Safari on iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    expect(truncateUserAgent(ua)).toBe("Safari/iOS");
  });

  it("identifies Edge ahead of Chrome (Edge UA contains 'Chrome/')", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
    expect(truncateUserAgent(ua)).toBe("Edge/Windows");
  });

  it("identifies Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    expect(truncateUserAgent(ua)).toBe("Chrome/Android");
  });

  it("identifies a bare reqwest UA (no OS token) as 'reqwest', and appends the OS when present", () => {
    // The sharer's reqwest client sets no custom UA, so the bare form is
    // what actually arrives; the OS-bearing form pins the general rule.
    expect(truncateUserAgent("reqwest/0.13.3")).toBe("reqwest");
    expect(truncateUserAgent("reqwest/0.13.3 (Linux)")).toBe("reqwest/Linux");
  });

  it("identifies curl probes", () => {
    expect(truncateUserAgent("curl/8.20.0")).toBe("curl");
  });

  it("returns OS-only when the browser cannot be classified", () => {
    expect(truncateUserAgent("PostmanRuntime/7.36 (Linux)")).toBe("Linux");
  });

  it("returns 'unknown' when neither browser nor OS match", () => {
    expect(truncateUserAgent("Mysterious-Bot/1.0")).toBe("unknown");
  });

  it("clamps oversized UAs (defense vs malicious 100k-Byte UA)", () => {
    const huge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/" + "X".repeat(50_000) + " Chrome/130";
    // No crash, no DoS — slice(0,1000) before regex.
    expect(truncateUserAgent(huge)).toBe("Windows");
  });
});
