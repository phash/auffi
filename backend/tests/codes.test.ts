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
});

describe("SessionStore", () => {
  it("registers a sharer and returns a code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("retrieves session by code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    const session = store.getSession(code);
    expect(session?.sharer).toBe(sharer);
  });

  it("returns null for unknown code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    expect(store.getSession("000-000-000")).toBeNull();
  });

  it("expires sessions after ttl", async () => {
    const store = new SessionStore({ ttlMs: 50, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    await new Promise((r) => setTimeout(r, 80));
    expect(store.getSession(code)).toBeNull();
  });

  it("burns code after maxAttempts failed joins", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 3 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    expect(store.recordFailedAttempt(code)).toBe(false); // not burned
    expect(store.recordFailedAttempt(code)).toBe(false);
    expect(store.recordFailedAttempt(code)).toBe(true); // 3rd burns
    expect(store.getSession(code)).toBeNull();
  });

  it("removes session on disconnect", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.removeBySharer(sharer);
    expect(store.getSession(code)).toBeNull();
  });

  it("findByPeer locates session by sharer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    store.registerSharer(sharer);
    const session = store.findByPeer(sharer);
    expect(session?.sharer).toBe(sharer);
  });

  it("findByPeer locates session by viewer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    const session = store.findByPeer(viewer);
    expect(session?.viewer).toBe(viewer);
  });

  it("findByPeer returns null for unknown peer", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    expect(store.findByPeer({} as object)).toBeNull();
  });

  it("detachViewer removes viewer from session, session still findable by sharer", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
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
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const stranger = { id: "x1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    store.detachViewer(stranger); // stranger has no session — must be a no-op
    const session = store.getSession(code);
    expect(session?.viewer).toBe(viewer);
  });

  it("recordFailedAttempt returns false for unknown code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    expect(store.recordFailedAttempt("000-000-000")).toBe(false);
  });
});
