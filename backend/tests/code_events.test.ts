import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { recordCodeCreated, queryCodeStats } from "../src/tracking/code_events.js";

function freshDb(): Db {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

describe("recordCodeCreated", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts one row with the given timestamp", () => {
    recordCodeCreated(db, 1_700_000_000_000);
    const rows = db
      .prepare("SELECT created_at FROM code_events")
      .all() as Array<{ created_at: number }>;
    expect(rows).toEqual([{ created_at: 1_700_000_000_000 }]);
  });

  it("monotonically grows with repeated calls", () => {
    for (let i = 0; i < 5; i++) recordCodeCreated(db, 1_700_000_000_000 + i);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM code_events").get() as { n: number }
    ).n;
    expect(n).toBe(5);
  });

  it("swallows errors so the mint flow is never blocked", () => {
    db.prepare("DROP TABLE code_events").run();
    expect(() => recordCodeCreated(db, Date.now())).not.toThrow();
  });
});

describe("queryCodeStats", () => {
  let db: Db;
  const NOW = 1_700_000_000_000;
  const ONE_MIN = 60 * 1000;
  const ONE_HOUR = 60 * ONE_MIN;
  const ONE_DAY = 24 * ONE_HOUR;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns all zeros on an empty table", () => {
    const stats = queryCodeStats(db, NOW);
    expect(stats).toEqual({
      total: 0,
      last24h: 0,
      last7d: 0,
      last30d: 0,
      perDay: [],
    });
  });

  it("buckets events into 24h / 7d / 30d windows", () => {
    recordCodeCreated(db, NOW - 30 * ONE_MIN);
    recordCodeCreated(db, NOW - 12 * ONE_HOUR);
    recordCodeCreated(db, NOW - 3 * ONE_DAY);
    recordCodeCreated(db, NOW - 10 * ONE_DAY);
    recordCodeCreated(db, NOW - 20 * ONE_DAY);
    recordCodeCreated(db, NOW - 100 * ONE_DAY);

    const stats = queryCodeStats(db, NOW);
    expect(stats.total).toBe(6);
    expect(stats.last24h).toBe(2);
    expect(stats.last7d).toBe(3);
    expect(stats.last30d).toBe(5);
  });

  it("perDay groups by ISO date (UTC) and orders newest first", () => {
    recordCodeCreated(db, NOW - 10 * ONE_HOUR);
    recordCodeCreated(db, NOW - 11 * ONE_HOUR);
    recordCodeCreated(db, NOW - 12 * ONE_HOUR);
    recordCodeCreated(db, NOW - 36 * ONE_HOUR);

    const stats = queryCodeStats(db, NOW);
    expect(stats.perDay.length).toBe(2);
    expect(stats.perDay[0].count).toBe(3);
    expect(stats.perDay[1].count).toBe(1);
    expect(stats.perDay[0].day > stats.perDay[1].day).toBe(true);
  });

  it("excludes events older than 30d from perDay", () => {
    recordCodeCreated(db, NOW - 60 * ONE_DAY);
    recordCodeCreated(db, NOW - 1 * ONE_DAY);
    const stats = queryCodeStats(db, NOW);
    expect(stats.perDay.length).toBe(1);
    expect(stats.total).toBe(2);
  });
});
