import { describe, it, expect } from "vitest";
import { decideAction } from "../src/matomo-consent-decision.js";

describe("decideAction (Matomo-Consent)", () => {
  it("respects Do-Not-Track over any stored consent — DNT wins", () => {
    expect(decideAction(null, true)).toBe("skip");
    expect(decideAction("ok", true)).toBe("skip");
    expect(decideAction("no", true)).toBe("skip");
  });

  it("loads Matomo on explicit OK without DNT", () => {
    expect(decideAction("ok", false)).toBe("load");
  });

  it("skips Matomo silently on explicit No without DNT (no banner-spam)", () => {
    expect(decideAction("no", false)).toBe("skip");
  });

  it("shows the banner only on unknown consent without DNT", () => {
    expect(decideAction(null, false)).toBe("banner");
  });

  // Safety pin: the four-cell truth table is small enough to enumerate.
  // Anyone refactoring should keep all four combinations producing the
  // expected action.
  it.each<[Parameters<typeof decideAction>[0], Parameters<typeof decideAction>[1], string]>(
    [
      [null, false, "banner"],
      [null, true, "skip"],
      ["ok", false, "load"],
      ["ok", true, "skip"],
      ["no", false, "skip"],
      ["no", true, "skip"],
    ],
  )("decideAction(%j, %j) === %s", (consent, dnt, action) => {
    expect(decideAction(consent, dnt)).toBe(action);
  });
});
