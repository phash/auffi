import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeNumericCursor,
  decodeStringCursor,
  clampLimit,
  paginate,
} from "../src/admin/pagination.js";

describe("cursor encode/decode", () => {
  it("round-trips a numeric-id cursor", () => {
    const raw = encodeCursor({ createdAt: 1717171717171, id: 42 });
    expect(decodeNumericCursor(raw)).toEqual({ createdAt: 1717171717171, id: 42 });
  });

  it("round-trips a string-id cursor (device ids contain dashes)", () => {
    const raw = encodeCursor({ createdAt: 1717171717171, id: "123-456-789" });
    expect(decodeStringCursor(raw)).toEqual({ createdAt: 1717171717171, id: "123-456-789" });
  });

  it("rejects garbage input", () => {
    for (const bad of ["", "not-base64url!!!", Buffer.from("no-pipe-here").toString("base64url")]) {
      expect(decodeNumericCursor(bad)).toBeNull();
      expect(decodeStringCursor(bad)).toBeNull();
    }
  });

  it("rejects a non-numeric createdAt", () => {
    const raw = Buffer.from("abc|5", "utf-8").toString("base64url");
    expect(decodeNumericCursor(raw)).toBeNull();
    expect(decodeStringCursor(raw)).toBeNull();
  });

  it("rejects a non-numeric or empty id where a numeric id is required", () => {
    const nonNumeric = Buffer.from("123|abc", "utf-8").toString("base64url");
    expect(decodeNumericCursor(nonNumeric)).toBeNull();
    const empty = Buffer.from("123|", "utf-8").toString("base64url");
    expect(decodeNumericCursor(empty)).toBeNull();
    expect(decodeStringCursor(empty)).toBeNull();
  });
});

describe("clampLimit", () => {
  it("falls back to the default when unset or non-numeric", () => {
    expect(clampLimit(undefined, 25, 100)).toBe(25);
    expect(clampLimit("abc", 25, 100)).toBe(25);
    expect(clampLimit("", 25, 100)).toBe(25);
  });

  it("rejects zero and negatives", () => {
    expect(clampLimit("0", 25, 100)).toBe(25);
    expect(clampLimit("-5", 25, 100)).toBe(25);
  });

  it("rejects non-integers — SQLite refuses a REAL bound to LIMIT", () => {
    expect(clampLimit("1.5", 25, 100)).toBe(25);
    expect(clampLimit("1e-3", 25, 100)).toBe(25);
  });

  it("caps at the maximum", () => {
    expect(clampLimit("500", 25, 100)).toBe(100);
  });

  it("passes through an in-range value", () => {
    expect(clampLimit("7", 25, 100)).toBe(7);
  });
});

describe("paginate", () => {
  type Row = { created_at: number; id: number };
  const cursorOf = (r: Row) => encodeCursor({ createdAt: r.created_at, id: r.id });

  it("returns all rows and no cursor when the page is not full", () => {
    const rows: Row[] = [{ created_at: 3, id: 3 }, { created_at: 2, id: 2 }];
    const page = paginate(rows, 5, cursorOf);
    expect(page.visible).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("slices to `limit` and derives the cursor from the last visible row (limit+1 trick)", () => {
    const rows: Row[] = [
      { created_at: 3, id: 3 },
      { created_at: 2, id: 2 },
      { created_at: 1, id: 1 },
    ];
    const page = paginate(rows, 2, cursorOf);
    expect(page.visible).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeNumericCursor(page.nextCursor!)).toEqual({ createdAt: 2, id: 2 });
  });

  it("returns null cursor for an empty result", () => {
    const page = paginate([] as Row[], 10, cursorOf);
    expect(page.visible).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});
