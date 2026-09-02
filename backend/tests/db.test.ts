import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, applyMigrations, type Db } from "../src/db.js";

describe("openDb", () => {
  it("opens an in-memory DB with WAL+FK pragmas applied", () => {
    const db = openDb(":memory:");
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("opens a file-backed DB and sets journal_mode=wal", () => {
    const dir = mkdtempSync(join(tmpdir(), "auffi-db-"));
    const path = join(dir, "test.db");
    const db = openDb(path);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories on demand", () => {
    const dir = mkdtempSync(join(tmpdir(), "auffi-db-"));
    const path = join(dir, "nested", "subdir", "test.db");
    const db = openDb(path);
    try {
      // If parent-dir creation failed, openDb would have thrown.
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyMigrations", () => {
  let db: Db;
  let migrationsDir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    migrationsDir = mkdtempSync(join(tmpdir(), "auffi-mig-"));
  });

  afterEach(() => {
    db.close();
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("creates schema_migrations on first run", () => {
    applyMigrations(db, migrationsDir);
    const table = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(table?.name).toBe("schema_migrations");
  });

  it("applies new migrations in numeric order", () => {
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE foo (id INTEGER);");
    writeFileSync(join(migrationsDir, "0002_add_bar.sql"), "CREATE TABLE bar (id INTEGER);");

    const { applied } = applyMigrations(db, migrationsDir);

    expect(applied).toEqual(["0001_init.sql", "0002_add_bar.sql"]);
    const versions = db
      .prepare<[], { version: number; filename: string }>(
        "SELECT version, filename FROM schema_migrations ORDER BY version",
      )
      .all();
    expect(versions).toEqual([
      { version: 1, filename: "0001_init.sql" },
      { version: 2, filename: "0002_add_bar.sql" },
    ]);
  });

  it("skips migrations that have already been applied", () => {
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE foo (id INTEGER);");

    applyMigrations(db, migrationsDir);
    const second = applyMigrations(db, migrationsDir);

    expect(second.applied).toEqual([]);
    const count = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM schema_migrations").get();
    expect(count?.c).toBe(1);
  });

  it("applies only the new file when later migrations are added", () => {
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE foo (id INTEGER);");
    applyMigrations(db, migrationsDir);

    writeFileSync(join(migrationsDir, "0002_add_bar.sql"), "CREATE TABLE bar (id INTEGER);");
    const second = applyMigrations(db, migrationsDir);

    expect(second.applied).toEqual(["0002_add_bar.sql"]);
  });

  it("rolls back the transaction on syntax error and stops", () => {
    writeFileSync(join(migrationsDir, "0001_ok.sql"), "CREATE TABLE good (id INTEGER);");
    writeFileSync(
      join(migrationsDir, "0002_broken.sql"),
      "NOT VALID SQL AT ALL;",
    );

    expect(() => applyMigrations(db, migrationsDir)).toThrow();

    // The first one applied, the second one did not — and crucially the
    // schema_migrations row for the broken file was NOT inserted.
    const versions = db
      .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version);
    expect(versions).toEqual([1]);

    // The broken file's effects (none, since SQL failed) are absent —
    // table from the OK file still exists.
    const ok = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='good'")
      .get();
    expect(ok?.name).toBe("good");
  });

  // SQLite ignores `PRAGMA foreign_keys` while a transaction is open, and
  // the runner wraps every file in one. Migrations 0009/0011 rebuilt child
  // tables under a PRAGMA OFF that was silently inert — harmless there, but
  // the same template applied to a PARENT table (accounts, devices) would
  // cascade-delete every child row on deploy. Files that toggle the pragma
  // have to get it applied for real, outside the transaction.
  it("honours PRAGMA foreign_keys = OFF in a migration that rebuilds a parent table", () => {
    writeFileSync(
      join(migrationsDir, "0001_init.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
       CREATE TABLE child (id INTEGER PRIMARY KEY,
         parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
       INSERT INTO parent (id, name) VALUES (1, 'p');
       INSERT INTO child (id, parent_id) VALUES (1, 1);`,
    );
    writeFileSync(
      join(migrationsDir, "0002_rebuild_parent.sql"),
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, extra TEXT);
       INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
       DROP TABLE parent;
       ALTER TABLE parent_new RENAME TO parent;
       PRAGMA foreign_keys = ON;`,
    );

    const { applied } = applyMigrations(db, migrationsDir);
    expect(applied).toEqual(["0001_init.sql", "0002_rebuild_parent.sql"]);
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM child").get()!.c).toBe(1);
    // Enforcement is back on for the connection afterwards.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO child (id, parent_id) VALUES (2, 99)").run()).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects a pragma-toggling migration that leaves a dangling reference", () => {
    writeFileSync(
      join(migrationsDir, "0001_init.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
       INSERT INTO parent (id) VALUES (1);
       INSERT INTO child (id, parent_id) VALUES (1, 1);`,
    );
    writeFileSync(
      join(migrationsDir, "0002_break.sql"),
      `PRAGMA foreign_keys = OFF;
       DELETE FROM parent WHERE id = 1;
       PRAGMA foreign_keys = ON;`,
    );

    expect(() => applyMigrations(db, migrationsDir)).toThrow(/foreign key/i);
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM parent").get()!.c).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("ignores files without the NNNN_*.sql prefix", () => {
    writeFileSync(join(migrationsDir, "0001_init.sql"), "CREATE TABLE foo (id INTEGER);");
    writeFileSync(join(migrationsDir, "README.md"), "# not a migration");
    writeFileSync(join(migrationsDir, "scratch.sql"), "CREATE TABLE nope (id INTEGER);");

    const { applied } = applyMigrations(db, migrationsDir);
    expect(applied).toEqual(["0001_init.sql"]);
  });
});

describe("applyMigrations against the real bundled migrations directory", () => {
  it("applies all checked-in migrations from a fresh DB", async () => {
    const { defaultMigrationsDir } = await import("../src/db.js");
    const db = openDb(":memory:");
    try {
      const { applied } = applyMigrations(db, defaultMigrationsDir());
      expect(applied.length).toBeGreaterThan(0);
      // Running again on the same DB applies nothing new.
      const second = applyMigrations(db, defaultMigrationsDir());
      expect(second.applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * Sec C-1 regression pin (review 2026-05-13). The `sessions` table
   * must NOT carry the raw cookie value alongside the hash — that
   * defeats the entire reason `token_hash` exists. Anyone tempted to
   * resurrect an `id` column "for joins" must fail this test.
   */
  it("sessions table has no plaintext-cookie 'id' column (Sec C-1)", async () => {
    const { defaultMigrationsDir } = await import("../src/db.js");
    const db = openDb(":memory:");
    try {
      applyMigrations(db, defaultMigrationsDir());
      const cols = db
        .prepare<[], { name: string }>("PRAGMA table_info(sessions)")
        .all()
        .map((r) => r.name);
      expect(cols).not.toContain("id");
      expect(cols).toContain("token_hash");
      // token_hash is the primary key.
      const pkCols = db
        .prepare<[], { name: string; pk: number }>("PRAGMA table_info(sessions)")
        .all()
        .filter((r) => r.pk > 0)
        .map((r) => r.name);
      expect(pkCols).toEqual(["token_hash"]);
    } finally {
      db.close();
    }
  });
});
