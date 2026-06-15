import { describe, it, expect } from "vitest";
import { generateCode, normalizeCode, SessionStore } from "../src/codes.js";

describe("generateCode", () => {
  it("produces 11-character code in format DDD-DDD-DDD", () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("produces different codes on repeated calls", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(90); // collisions extremely unlikely
  });
});

describe("normalizeCode", () => {
  it("strips spaces and dashes", () => {
    expect(normalizeCode("284 915 073")).toBe("284-915-073");
    expect(normalizeCode("284915073")).toBe("284-915-073");
    expect(normalizeCode("284-915-073")).toBe("284-915-073");
  });

  it("returns null for invalid codes", () => {
    expect(normalizeCode("abc")).toBeNull();
    expect(normalizeCode("123")).toBeNull();
    expect(normalizeCode("1234567890")).toBeNull();
  });

  it("returns null immediately for inputs longer than 20 characters", () => {
    const longInput = "1".repeat(200_000);
    const start = performance.now();
    const result = normalizeCode(longInput);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(5);
  });

  // Defence-in-depth: a malformed JSON message (POJO from JSON.parse) might
  // hand us a non-string. The TS type says "string" but at the network
  // boundary that's not a guarantee. The runtime guard at line 11 of
  // codes.ts catches this — these cases pin that guard so a regression
  // can't silently drop it. (gh #84)
  it("returns null for non-string input", () => {
    // Each cast skips the compile-time check to mimic a network-boundary
    // payload that smuggled in the wrong type.
    expect(normalizeCode(null as unknown as string)).toBeNull();
    expect(normalizeCode(undefined as unknown as string)).toBeNull();
    expect(normalizeCode(123 as unknown as string)).toBeNull();
    expect(normalizeCode([] as unknown as string)).toBeNull();
    expect(normalizeCode({} as unknown as string)).toBeNull();
    expect(normalizeCode(true as unknown as string)).toBeNull();
  });
});

describe("SessionStore", () => {
  it("registers a sharer and returns a code", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("retrieves session by code", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    const session = store.getSession(code);
    expect(session?.sharer).toBe(sharer);
  });

  it("returns null for unknown code", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    expect(store.getSession("000-000-000")).toBeNull();
  });

  it("expires sessions after ttl", async () => {
    const store = new SessionStore({ ttlMs: 50 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    await new Promise((r) => setTimeout(r, 80));
    expect(store.getSession(code)).toBeNull();
  });

  it("removes session on disconnect", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.removeBySharer(sharer);
    expect(store.getSession(code)).toBeNull();
  });

  it("findByPeer locates session by sharer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    store.registerSharer(sharer);
    const session = store.findByPeer(sharer);
    expect(session?.sharer).toBe(sharer);
  });

  it("findByPeer locates session by viewer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    const session = store.findByPeer(viewer);
    expect(session?.viewer).toBe(viewer);
  });

  it("findByPeer returns null for unknown peer", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    expect(store.findByPeer({} as object)).toBeNull();
  });

  it("detachViewer removes viewer from session, session still findable by sharer", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    store.detachViewer(viewer);
    const session = store.getSession(code);
    expect(session).not.toBeNull();
    expect(session?.viewer).toBeNull();
    expect(session?.sharer).toBe(sharer);
  });

  it("detachViewer is a no-op when called with a peer that is not the attached viewer", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const stranger = { id: "x1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    store.detachViewer(stranger); // stranger has no session — must be a no-op
    const session = store.getSession(code);
    expect(session?.viewer).toBe(viewer);
  });

  it("invokes onCodeCreated after a successful mint", () => {
    let calls = 0;
    const store = new SessionStore({
      ttlMs: 600_000,
      onCodeCreated: () => {
        calls += 1;
      },
    });
    store.registerSharer({ id: "s1" } as unknown as object);
    store.registerSharer({ id: "s2" } as unknown as object);
    expect(calls).toBe(2);
  });

  it("does NOT invoke onCodeCreated when no callback configured", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    expect(() =>
      store.registerSharer({ id: "s1" } as unknown as object)
    ).not.toThrow();
  });

  it("sweepExpired removes sessions past their TTL and keeps live ones", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const s1 = { id: "s1" } as unknown as object;
    const s2 = { id: "s2" } as unknown as object;
    const { code: code1 } = store.registerSharer(s1);
    const { code: code2 } = store.registerSharer(s2);

    // Expire code1 by sweeping with a future timestamp.
    const future = Date.now() + 700_000;
    // code2's session is still live at 'now' but expired at 'future'.
    // Pass a timestamp past both TTLs → both swept.
    store.sweepExpired(future);
    expect(store.getSession(code1)).toBeNull();
    expect(store.getSession(code2)).toBeNull();
  });

  it("sweepExpired leaves sessions that have not yet expired", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    // Sweep at 'now' — session expires at now + 600_000, so not swept.
    store.sweepExpired(Date.now());
    expect(store.getSession(code)).not.toBeNull();
  });

  it("sweepExpired also cleans up byPeer index (findByPeer returns null after sweep)", () => {
    const store = new SessionStore({ ttlMs: 600_000 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    store.sweepExpired(Date.now() + 700_000);
    expect(store.findByPeer(sharer)).toBeNull();
    expect(store.findByPeer(viewer)).toBeNull();
  });
});
