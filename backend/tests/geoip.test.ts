import { describe, it, expect } from "vitest";
import { lookupCountry, openCountryDb, type CountryLookup } from "../src/geoip.js";

const fakeReader: CountryLookup = {
  get(ip: string) {
    if (ip === "84.1.2.3") return { country: { iso_code: "DE" } };
    if (ip === "8.8.8.8") return { country: { iso_code: "US" } };
    if (ip === "10.0.0.1") return null; // private — not in DB
    throw new Error("invalid ip"); // maxmind throws on malformed input
  },
};

describe("lookupCountry", () => {
  it("returns the ISO code for a known IP", () => {
    expect(lookupCountry(fakeReader, "84.1.2.3")).toBe("DE");
    expect(lookupCountry(fakeReader, "8.8.8.8")).toBe("US");
  });
  it("returns null for a private/unknown IP", () => {
    expect(lookupCountry(fakeReader, "10.0.0.1")).toBeNull();
  });
  it("returns null (never throws) for a malformed IP", () => {
    expect(lookupCountry(fakeReader, "not-an-ip")).toBeNull();
  });
  it("returns null when no reader is configured", () => {
    expect(lookupCountry(null, "84.1.2.3")).toBeNull();
  });
});

describe("openCountryDb", () => {
  it("returns null for an undefined path", () => {
    expect(openCountryDb(undefined)).toBeNull();
  });
  it("returns null (never throws) for a missing file", () => {
    expect(openCountryDb("/nonexistent/dbip.mmdb")).toBeNull();
  });
});
