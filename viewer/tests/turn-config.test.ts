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
  it("returns merged TURN + fallback STUN array when endpoint returns 200", async () => {
    const body = {
      urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
      username: "12345:test-user",
      credential: "abc123==",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(200, body)));

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: "stun:stun.example.com:3478",
    });

    expect(result).toHaveLength(3);
    const turnEntries = result.filter(
      (s): s is IceServer & { username: string; credential: string } =>
        s.username !== undefined,
    );
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries[0].urls).toBe("turn:turn.example.com:3478");
    expect(turnEntries[0].username).toBe("12345:test-user");
    expect(turnEntries[0].credential).toBe("abc123==");
    expect(turnEntries[1].urls).toBe("turns:turn.example.com:5349");

    const stunEntry = result.at(-1);
    expect(stunEntry?.urls).toBe("stun:stun.example.com:3478");
    expect(stunEntry?.username).toBeUndefined();
  });

  it("returns just fallback STUN on 4xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(403, {})));

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: "stun:stun.example.com:3478",
    });

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("stun:stun.example.com:3478");
    expect(result[0].username).toBeUndefined();
  });

  it("returns just fallback STUN on 5xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(500, {})));

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: "stun:stun.example.com:3478",
    });

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("stun:stun.example.com:3478");
  });

  it("returns just fallback STUN on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: "stun:stun.example.com:3478",
    });

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("stun:stun.example.com:3478");
  });

  it("returns just fallback STUN on AbortError (timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      ),
    );

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: "stun:stun.example.com:3478",
    });

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("stun:stun.example.com:3478");
  });

  it("returns empty array when fallback is unset and endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: undefined,
    });

    expect(result).toEqual([]);
  });

  it("calls the correct endpoint URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(200, {
      urls: ["turn:relay.example.com:3478"],
      username: "u",
      credential: "c",
    }));
    vi.stubGlobal("fetch", mockFetch);

    await fetchIceServers("https://api.example.com");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/turn-credentials",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns only TURN entries (no fallback) when fallback is unset and endpoint succeeds", async () => {
    const body = {
      urls: ["turn:relay.example.com:3478"],
      username: "user",
      credential: "cred",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeFetchResponse(200, body)));

    const result = await fetchIceServers("http://localhost:8080", {
      fallbackStun: undefined,
    });

    expect(result).toHaveLength(1);
    expect(result[0].urls).toBe("turn:relay.example.com:3478");
    expect(result[0].username).toBe("user");
  });
});
