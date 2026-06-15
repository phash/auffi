import { describe, it, expect } from "vitest";
import { countryName, formatConnectionRequest } from "../src/connect-format.js";

describe("countryName", () => {
  it("maps an ISO code to a German region name", () => {
    expect(countryName("DE")).toBe("Deutschland");
    expect(countryName("us")).toBe("Vereinigte Staaten");
  });
  it("falls back to the upper-case code for unknown/invalid input", () => {
    expect(countryName(null)).toBeNull();
    expect(countryName("ZZ")).toBe("ZZ");
    expect(countryName("123")).toBeNull();
  });
});

describe("formatConnectionRequest", () => {
  it("includes the country when present", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: "DE", trusted: false }))
      .toBe("Verbindungsanfrage aus Deutschland · 84.xxx");
  });
  it("falls back to ip-only without a country", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: null, trusted: false }))
      .toBe("Verbindungsanfrage von 84.xxx");
  });
  it("appends the trusted hint", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: "DE", trusted: true }))
      .toBe("Verbindungsanfrage aus Deutschland · 84.xxx · bekannter Helfer (frühere Verbindung)");
  });
});
