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

  it("reflects persisted counts for known assets", async () => {
    const asset = "Auffi_0.4.2_amd64.deb";
    h.db
      .prepare("INSERT INTO download_counts (asset_name, count, updated_at) VALUES (?, 3, ?)")
      .run(asset, Date.now());
    const res = await h.app.inject({ method: "GET", url: "/api/downloads" });
    expect(res.json().counts[asset]).toBe(3);
  });

  it("allow-lists every asset of the current release (v0.6.4) that the download pages link", () => {
    // These names must match the GitHub release assets 1:1 — the pages in
    // viewer/public/download/ and viewer/index.html link them through the
    // proxy, which 404s anything off-list.
    const current = [
      "Auffi_0.6.4_amd64.deb",
      "Auffi-0.6.4-1.x86_64.rpm",
      "Auffi_0.6.4_amd64.AppImage",
      "Auffi_0.6.4_x64-setup.exe",
      "Auffi_0.6.4_x64_en-US.msi",
      "Auffi_0.6.4_x64_portable.exe",
    ];
    for (const a of current) expect(KNOWN_ASSETS.has(a)).toBe(true);
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

describe("POST /api/downloads/:asset (removed legacy counter endpoint)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("no longer exists — stale cached pages get a 404 and no counter bump", async () => {
    // The sendBeacon POST was replaced by the GET file-proxy which bumps
    // the counter itself; the write-open POST surface stays gone.
    const res = await h.app.inject({
      method: "POST",
      url: "/api/downloads/Auffi_0.4.2_amd64.deb",
    });
    expect(res.statusCode).toBe(404);
    const rows = h.db.prepare("SELECT COUNT(*) AS c FROM download_counts").get() as { c: number };
    expect(rows.c).toBe(0);
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

  it("returns 502 (not 500) and no counter bump when the upstream fetch itself rejects", async () => {
    // DNS failure, ECONNRESET, TLS error: undici rejects with "fetch failed"
    // before there is a Response to inspect. That is the same upstream
    // outage as a non-2xx and must map to the documented 502 contract.
    h = await build(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream-unavailable");
    const row = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number } | undefined;
    expect(row?.count ?? 0).toBe(0);
  });

  it("cancels the upstream body on the 502 path so the connection is released", async () => {
    // A non-ok upstream response with a body (GitHub 404 page) must not
    // leave the undici connection half-open until GC.
    let cancelled = false;
    h = await build(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 404 },
      ),
    );
    const res = await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(res.statusCode).toBe(502);
    // cancel() propagates through a microtask — allow one tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
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

  it("HEAD does NOT increment the counter and does NOT fetch upstream", async () => {
    // A scraper or link-preview crawler hitting HEAD shouldn't inflate
    // the per-asset counter or burn proxy-bandwidth. Real download =
    // GET only.
    let upstreamCalled = false;
    h = await build(async () => {
      upstreamCalled = true;
      return new Response(payload, { status: 200 });
    });
    const res = await h.app.inject({
      method: "HEAD",
      url: `/api/downloads/file/${asset}`,
    });
    expect(res.statusCode).toBe(200);
    expect(upstreamCalled).toBe(false);
    const row = h.db
      .prepare("SELECT count FROM download_counts WHERE asset_name = ?")
      .get(asset) as { count: number } | undefined;
    expect(row?.count ?? 0).toBe(0);
  });

  it("HEAD still sets attachment headers so monitoring tools see the right Content-Disposition", async () => {
    h = await build(okFetcher());
    const res = await h.app.inject({
      method: "HEAD",
      url: `/api/downloads/file/${asset}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${asset}"`);
  });

  it("HEAD on an unknown asset still 404s (allow-list applies before HEAD short-circuit)", async () => {
    h = await build(okFetcher());
    const res = await h.app.inject({
      method: "HEAD",
      url: "/api/downloads/file/totally-unknown-asset.deb",
    });
    expect(res.statusCode).toBe(404);
  });

  it("forces Content-Type application/octet-stream regardless of upstream — MIME-confusion defence", async () => {
    // Upstream lies about its content type (text/html). Proxy must
    // override so a malformed upstream-2xx-with-HTML-body never
    // reaches the browser as HTML.
    h = await build(async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const res = await h.app.inject({ method: "GET", url: `/api/downloads/file/${asset}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
