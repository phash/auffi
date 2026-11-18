import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("tokens sync", () => {
  it("viewer/public/tokens.css is an exact copy of design/tokens.css", () => {
    expect(
      read("../public/tokens.css") === read("../../design/tokens.css"),
      "viewer/public/tokens.css is stale — run `npm run tokens:sync` in viewer/",
    ).toBe(true);
  });
});
