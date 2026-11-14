import { describe, it, expect } from "vitest";
import type { ApiErr } from "../src/api.js";
import { localizedError } from "../src/error-copy.js";

function err(code: string, message: string): ApiErr {
  return { ok: false, status: 400, code, message };
}

describe("localizedError", () => {
  it("returns the German copy for a known code", () => {
    expect(localizedError(err("forbidden", "not your device"), { forbidden: "Kein Zugriff." })).toBe(
      "Kein Zugriff.",
    );
  });

  it("falls back to the backend message for an unknown code", () => {
    expect(localizedError(err("internal", "kaputt"), { forbidden: "Kein Zugriff." })).toBe("kaputt");
  });

  it("does not treat inherited object keys as codes", () => {
    expect(localizedError(err("constructor", "odd"), {})).toBe("odd");
  });
});
