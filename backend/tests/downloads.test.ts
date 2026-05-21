import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerDownloadRoutes, KNOWN_ASSETS } from "../src/downloads/handlers.js";

async function build(
  upstreamFetcher?: (asset: string) => Promise<Response>,
): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  registerDownloadRoutes(app, db, upstreamFetcher ? { upstreamFetcher } : undefined);
  await app.ready();
  return { app, db };
}

describe("GET /api/downloads", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns zero for every known asset before any clicks", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/downloads" });
    expect(res.statusCode).toBe(200);
    const { counts } = res.json();
    for (const a of KNOWN_ASSETS) {
      expect(counts[a]).toBe(0);
    }
  });

  it("reflects incremented counts after POSTs", async () => {
    const asset = "Auffi_0.4.2_amd64.deb";
    for (let i = 0; i < 3; i++) {
      await h.app.inject({ method: "POST", url: `/api/downloads/${asset}` });
    }
    const res = await h.app.inject({ method: "GET", url: "/api/downloads" });
    expect(res.json().counts[asset]).toBe(3);
  });

  it("ignores rows that aren't in the allow-list (defensive — table is shared via SQLite)", async () => {
    // Seed an off-list row directly; the GET handler should filter it out.
    h.db.prepare(
      "INSERT INTO download_counts (asset_name, count, updated_at) VALUES (?, ?, ?)",
    ).run("rogue.tar.gz", 9999, Date.now());
    const res = await h.app.inject({ method: "GET", url: "/api/downloads" });
    const counts = res.json().counts;
    expect(counts["rogue.tar.gz"]).toBeUndefined();
    for (const a of KNOWN_ASSETS) expect(counts[a]).toBeTypeOf("number");
  });
});

describe("POST /api/downloads/:asset", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("increments from 0 to 1 on first click and returns the new count", async () => {
    const asset = "Auffi-0.4.2-1.x86_64.rpm";
    const res = await h.app.inject({
      method: "POST",
      url: `/api/downloads/${asset}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, count: 1 });
    const row = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number };
    expect(row.count).toBe(1);
  });

  it("increments monotonically on repeated clicks (no UPSERT bug)", async () => {
    const asset = "Auffi_0.4.2_amd64.AppImage";
    for (let i = 1; i <= 5; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/downloads/${asset}`,
      });
      expect(res.json().count).toBe(i);
    }
  });

  it("404s for assets not on the allow-list (prevents arbitrary-key flooding)", async () => {
    for (const asset of ["../etc/passwd", "definitely-not-an-asset", "x".repeat(200)]) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/downloads/${encodeURIComponent(asset)}`,
      });
      expect(res.statusCode, `asset="${asset.slice(0, 20)}…"`).toBe(404);
    }
    // None of those rogue names made it into the table.
    const rogueRows = h.db
      .prepare("SELECT COUNT(*) AS c FROM download_counts")
      .get() as { c: number };
    expect(rogueRows.c).toBe(0);
  });

  it("updates updated_at on every increment", async () => {
    const asset = "auffi-sharer-windows-x64.exe";
    await h.app.inject({ method: "POST", url: `/api/downloads/${asset}` });
    const t1 = (h.db
      .prepare("SELECT updated_at FROM download_counts WHERE asset_name = ?")
      .get(asset) as { updated_at: number }).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await h.app.inject({ method: "POST", url: `/api/downloads/${asset}` });
    const t2 = (h.db
      .prepare("SELECT updated_at FROM download_counts WHERE asset_name = ?")
      .get(asset) as { updated_at: number }).updated_at;
    expect(t2).toBeGreaterThan(t1);
  });

  it("does not require auth — counters are public-write by design", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/downloads/Auffi_0.4.2_amd64.deb",
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/downloads/file/:asset (stream-through proxy)", () => {
  const asset = "Auffi_0.4.4_amd64.deb";
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);

  function okFetcher(): (asset: string, tag?: string) => Promise<Response> {
    return async () =>
      new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
        },
      });
  }

  let h: Awaited<ReturnType<typeof build>>;
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("404s on assets not in the allow-list — without calling upstream", async () => {
    let upstreamCalled = false;
    h = await build(async (_asset, _tag) => {
      upstreamCalled = true;
      return new Response("nope", { status: 200 });
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/api/downloads/file/../etc/passwd",
    });
    // 404 here, not 200 — proxy must not echo upstream when the asset
    // name fails the allow-list check.
    expect(res.statusCode).toBe(404);
    expect(upstreamCalled).toBe(false);
  });

  it("streams the upstream body verbatim and sets attachment headers", async () => {
    h = await build(okFetcher());
    const res = await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${asset}"`);
    expect(res.headers["content-length"]).toBe(String(payload.byteLength));
    expect(new Uint8Array(res.rawPayload)).toEqual(payload);
  });

  it("increments the per-asset counter exactly once on success", async () => {
    h = await build(okFetcher());
    await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    const after = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number } | undefined;
    expect(after?.count).toBe(1);
    await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    const again = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number };
    expect(again.count).toBe(2);
  });

  it("returns 502 and does NOT increment the counter when upstream fails", async () => {
    h = await build(async (_asset, _tag) => new Response("not found", { status: 404 }));
    const res = await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(res.statusCode).toBe(502);
    const row = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number } | undefined;
    // Either the row never got inserted, or its count is still 0. Both
    // are valid "did not increment" outcomes.
    expect(row?.count ?? 0).toBe(0);
  });

  it("forwards a valid ?tag=vX.Y.Z to the upstream fetcher", async () => {
    let receivedTag: string | undefined = undefined;
    h = await build(async (_asset, tag) => {
      receivedTag = tag;
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.byteLength) },
      });
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/downloads/file/${asset}?tag=v0.4.4`,
    });
    expect(res.statusCode).toBe(200);
    expect(receivedTag).toBe("v0.4.4");
  });

  it("rejects a non-semver tag with 400 — defence against URL injection", async () => {
    let upstreamCalled = false;
    h = await build(async () => {
      upstreamCalled = true;
      return new Response(payload, { status: 200 });
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/api/downloads/file/${asset}?tag=../../etc/passwd`,
    });
    expect(res.statusCode).toBe(400);
    expect(upstreamCalled).toBe(false);
  });

  it("uses latest (tag undefined) when ?tag= is absent", async () => {
    let receivedTag: string | undefined = "sentinel";
    h = await build(async (_asset, tag) => {
      receivedTag = tag;
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.byteLength) },
      });
    });
    await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(receivedTag).toBeUndefined();
  });
});
