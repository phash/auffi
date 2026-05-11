import { describe, it, expect } from "vitest";
import { matchesTrustedPeer, addPeerToList, removePeerFromList } from "../src/trusted-peers.js";
import type { TrustedPeer } from "../src/trusted-peers.js";

function peer(ipPrefix: string, label = "Test"): TrustedPeer {
  return { ipPrefix, label, addedAt: 0 };
}

describe("matchesTrustedPeer", () => {
  it("returns true when the prefix is in the list", () => {
    const peers = [peer("84.xxx"), peer("192.xxx")];
    expect(matchesTrustedPeer("84.xxx", peers)).toBe(true);
  });

  it("returns false when the prefix is not in the list", () => {
    const peers = [peer("84.xxx")];
    expect(matchesTrustedPeer("10.xxx", peers)).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(matchesTrustedPeer("84.xxx", [])).toBe(false);
  });
});

describe("addPeerToList", () => {
  it("adds a new peer to an empty list", () => {
    const result = addPeerToList([], "84.xxx", "Alice");
    expect(result).toHaveLength(1);
    expect(result[0].ipPrefix).toBe("84.xxx");
    expect(result[0].label).toBe("Alice");
  });

  it("does not add a duplicate prefix", () => {
    const existing = [peer("84.xxx")];
    const result = addPeerToList(existing, "84.xxx", "duplicate");
    expect(result).toHaveLength(1);
  });

  it("adds a peer with a different prefix", () => {
    const existing = [peer("84.xxx")];
    const result = addPeerToList(existing, "192.xxx", "Bob");
    expect(result).toHaveLength(2);
    expect(result[1].ipPrefix).toBe("192.xxx");
  });

  it("does not mutate the original array", () => {
    const original = [peer("84.xxx")];
    addPeerToList(original, "10.xxx", "new");
    expect(original).toHaveLength(1);
  });
});

describe("removePeerFromList", () => {
  it("removes the matching peer", () => {
    const peers = [peer("84.xxx"), peer("192.xxx")];
    const result = removePeerFromList(peers, "84.xxx");
    expect(result).toHaveLength(1);
    expect(result[0].ipPrefix).toBe("192.xxx");
  });

  it("returns unchanged list when prefix not found", () => {
    const peers = [peer("84.xxx")];
    const result = removePeerFromList(peers, "10.xxx");
    expect(result).toHaveLength(1);
  });

  it("does not mutate the original array", () => {
    const original = [peer("84.xxx")];
    removePeerFromList(original, "84.xxx");
    expect(original).toHaveLength(1);
  });
});
