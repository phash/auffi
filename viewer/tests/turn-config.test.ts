import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIceServers } from "../src/turn-config.js";
import type { IceServer } from "../src/turn-config.js";

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchIceServers", () => {
  it("returns TURN servers when endpoint returns 200", async () => {
    const body = {
      urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
      username: "12345:test-user",
      credential: "abc123==",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(200, body)));

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toHaveLength(2);
    const turnEntries = result.filter(
      (s): s is IceServer & { username: string; credential: string } =>
        s.username !== undefined,
    );
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries[0].urls).toBe("turn:turn.example.com:3478");
    expect(turnEntries[0].username).toBe("12345:test-user");
    expect(turnEntries[0].credential).toBe("abc123==");
    expect(turnEntries[1].urls).toBe("turns:turn.example.com:5349");
  });

  it("returns empty array on 4xx response — no third-party STUN fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(403, {})));

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toEqual([]);
  });

  it("returns empty array on 5xx response — no third-party STUN fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(500, {})));

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toEqual([]);
  });

  it("returns empty array on network error — no third-party STUN fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toEqual([]);
  });

  it("returns empty array on AbortError (timeout) — no third-party STUN fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      ),
    );

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toEqual([]);
  });

  it("calls the correct endpoint URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(200, {
      urls: ["turn:relay.example.com:3478"],
      username: "u",
      credential: "c",
    }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchIceServers("https://api.example.com", "123-456-789");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/turn-credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    const calledOpts = mockFetch.mock.calls[0][1] as { body: string };
    expect(JSON.parse(calledOpts.body)).toEqual({ code: "123-456-789" });
  });

  it("returns only TURN entries when endpoint succeeds", async () => {
    const body = {
      urls: ["turn:relay.example.com:3478"],
      username: "user",
      credential: "cred",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(200, body)));

    const result = await fetchIceServers("http://localhost:8080", "123-456-789");

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("turn:relay.example.com:3478");
    expect(result[0].username).toBe("user");
  });
});
