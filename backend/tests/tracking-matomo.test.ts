import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createMatomoTracker,
  type MatomoTracker,
} from "../src/tracking/matomo.js";

type FetchCall = { url: string; init?: RequestInit };

function captureFetch(
  responder: () => Promise<Response> = async () =>
    new Response("", { status: 204 })
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: input.toString(), init });
    return responder();
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function parseBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("createMatomoTracker — config gating", () => {
  it("returns a no-op tracker when trackerUrl is empty", async () => {
    const probe = captureFetch();
    const tracker = createMatomoTracker({ trackerUrl: "", siteId: "6" });
    await tracker.trackCodeCreated();
    expect(probe.calls).toHaveLength(0);
    probe.restore();
  });

  it("returns a no-op tracker when siteId is empty", async () => {
    const probe = captureFetch();
    const tracker = createMatomoTracker({
      trackerUrl: "https://example.org/matomo/matomo.php",
      siteId: "",
    });
    await tracker.trackCodeCreated();
    expect(probe.calls).toHaveLength(0);
    probe.restore();
  });
});

describe("createMatomoTracker — POST payload", () => {
  let probe: ReturnType<typeof captureFetch>;
  let tracker: MatomoTracker;

  beforeEach(() => {
    probe = captureFetch();
    tracker = createMatomoTracker({
      trackerUrl: "https://musikersuche.org/matomo/matomo.php",
      siteId: "6",
    });
  });

  afterEach(() => probe.restore());

  it("POSTs to the configured tracker URL", async () => {
    await tracker.trackCodeCreated();
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].url).toBe(
      "https://musikersuche.org/matomo/matomo.php"
    );
    expect(probe.calls[0].init?.method).toBe("POST");
  });

  it("sends form-encoded body", async () => {
    await tracker.trackCodeCreated();
    const headers = new Headers(probe.calls[0].init?.headers);
    expect(headers.get("content-type")).toMatch(
      /application\/x-www-form-urlencoded/
    );
  });

  it("includes the required Matomo event params", async () => {
    await tracker.trackCodeCreated();
    const body = parseBody(probe.calls[0].init);
    expect(body.get("idsite")).toBe("6");
    expect(body.get("rec")).toBe("1");
    expect(body.get("e_c")).toBe("session");
    expect(body.get("e_a")).toBe("code_created");
  });

  it("does NOT include any PII fields (cip, uid, url, urlref, ua)", async () => {
    await tracker.trackCodeCreated();
    const body = parseBody(probe.calls[0].init);
    expect(body.get("cip")).toBeNull();
    expect(body.get("uid")).toBeNull();
    expect(body.get("_id")).toBeNull();
    expect(body.get("url")).toBeNull();
    expect(body.get("urlref")).toBeNull();
    expect(body.get("ua")).toBeNull();
    expect(body.get("lang")).toBeNull();
    expect(body.get("res")).toBeNull();
  });
});

describe("createMatomoTracker — failure handling", () => {
  it("swallows fetch rejection (Matomo unreachable does not break callers)", async () => {
    const probe = captureFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const tracker = createMatomoTracker({
      trackerUrl: "https://musikersuche.org/matomo/matomo.php",
      siteId: "6",
    });
    await expect(tracker.trackCodeCreated()).resolves.toBeUndefined();
    expect(probe.calls).toHaveLength(1);
    probe.restore();
  });

  it("swallows non-2xx response without throwing", async () => {
    const probe = captureFetch(async () => new Response("", { status: 500 }));
    const tracker = createMatomoTracker({
      trackerUrl: "https://musikersuche.org/matomo/matomo.php",
      siteId: "6",
    });
    await expect(tracker.trackCodeCreated()).resolves.toBeUndefined();
    probe.restore();
  });
});

describe("createMatomoTracker — env factory", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("matomoTrackerFromEnv() returns no-op when env missing", async () => {
    // Importing dynamically so the env mutation above is visible.
    delete process.env.MATOMO_TRACKER_URL;
    delete process.env.MATOMO_SITE_ID;
    const { matomoTrackerFromEnv } = await import(
      "../src/tracking/matomo.js"
    );
    const probe = captureFetch();
    await matomoTrackerFromEnv().trackCodeCreated();
    expect(probe.calls).toHaveLength(0);
    probe.restore();
  });

  it("matomoTrackerFromEnv() wires env into a live tracker", async () => {
    process.env.MATOMO_TRACKER_URL =
      "https://musikersuche.org/matomo/matomo.php";
    process.env.MATOMO_SITE_ID = "6";
    const { matomoTrackerFromEnv } = await import(
      "../src/tracking/matomo.js"
    );
    const probe = captureFetch();
    await matomoTrackerFromEnv().trackCodeCreated();
    expect(probe.calls).toHaveLength(1);
    const body = parseBody(probe.calls[0].init);
    expect(body.get("idsite")).toBe("6");
    probe.restore();
  });
});
