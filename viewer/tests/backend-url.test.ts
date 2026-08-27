import { describe, it, expect } from "vitest";
import { deriveBackendWsUrl } from "../src/backend-url.js";

describe("deriveBackendWsUrl", () => {
  it("prefers an explicit VITE_BACKEND_WS value", () => {
    expect(
      deriveBackendWsUrl(
        { protocol: "https:", host: "auffi.app", hostname: "auffi.app" },
        "wss://staging.example/signal",
      ),
    ).toBe("wss://staging.example/signal");
  });

  it("uses same-origin wss for https pages (production behind Caddy)", () => {
    expect(
      deriveBackendWsUrl(
        { protocol: "https:", host: "auffi.app", hostname: "auffi.app" },
        undefined,
      ),
    ).toBe("wss://auffi.app/signal");
  });

  it("uses same-origin ws for remote http hosts (LAN testing)", () => {
    expect(
      deriveBackendWsUrl(
        { protocol: "http:", host: "192.168.1.20:8080", hostname: "192.168.1.20" },
        undefined,
      ),
    ).toBe("ws://192.168.1.20:8080/signal");
  });

  it("falls back to the dev backend for vite dev on localhost:5173", () => {
    // Regression: the old check compared `host` (incl. port) to "localhost",
    // so vite dev derived ws://localhost:5173/signal — the vite server,
    // which has no /signal proxy — and every join failed.
    expect(
      deriveBackendWsUrl(
        { protocol: "http:", host: "localhost:5173", hostname: "localhost" },
        undefined,
      ),
    ).toBe("ws://localhost:8080/signal");
  });

  it("treats 127.0.0.1 like localhost", () => {
    expect(
      deriveBackendWsUrl(
        { protocol: "http:", host: "127.0.0.1:5173", hostname: "127.0.0.1" },
        undefined,
      ),
    ).toBe("ws://localhost:8080/signal");
  });

  it("falls back to the dev backend for file:// pages", () => {
    expect(
      deriveBackendWsUrl({ protocol: "file:", host: "", hostname: "" }, undefined),
    ).toBe("ws://localhost:8080/signal");
  });
});
