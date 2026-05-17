import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerDownloadRoutes, KNOWN_ASSETS } from "../src/downloads/handlers.js";

async function build(): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  registerDownloadRoutes(app, db);
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
