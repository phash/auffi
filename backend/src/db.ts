import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SQLite handle with auffi-specific connection settings applied.
 *
 * WAL mode lets concurrent readers see consistent snapshots while a single
 * writer is mid-transaction. `synchronous = NORMAL` is the recommended
 * pairing with WAL (the journal itself is fsync'd, but commits don't fsync
 * the main DB file every time).
 */
export type Db = Database.Database;

/**
 * Default path used when AUFFI_DB_PATH env var is unset. Kept under
 * /var/lib/auffi inside the production container; the Docker volume mount
 * in docker-compose.prod.yml materialises this.
 *
 * Override via `AUFFI_DB_PATH` — useful for tests (`:memory:`) and for
 * self-hosters who store the DB elsewhere on the host.
 */
export const DEFAULT_DB_PATH = "/var/lib/auffi/auffi.db";

/**
 * Open a connection to the SQLite file at `path`, creating parent dirs if
 * needed and applying the WAL + foreign-key pragmas every connection needs.
 *
 * `path` may be `:memory:` for tests — parent-dir creation is skipped then.
 */
export function openDb(path: string = process.env.AUFFI_DB_PATH ?? DEFAULT_DB_PATH): Db {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(path);
  // Recommended pragmas. WAL applies persistently; foreign_keys is
  // per-connection in SQLite and must be re-set on every open.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Apply every migration file in `migrationsDir` whose numeric prefix
 * is greater than the highest version already recorded in
 * `schema_migrations`. Idempotent: re-running with no new files is a no-op.
 *
 * Each `.sql` file is run inside a transaction so a syntax error rolls
 * back cleanly without leaving the schema half-applied. Files are sorted
 * by their leading 4-digit prefix (`0001_*.sql`, `0002_*.sql`, ...).
 *
 * SQLite ignores `PRAGMA foreign_keys` while a transaction is open, so a
 * table-rebuild migration that toggles it (the SQLite-FAQ recipe used by
 * 0009/0011) would run with enforcement ON and, for a PARENT table,
 * cascade-delete every child row on deploy. A file containing that
 * pragma therefore gets enforcement switched off around its transaction
 * and a `PRAGMA foreign_key_check` before commit, so a rebuild that left
 * dangling references rolls back instead of landing silently.
 */
const FOREIGN_KEYS_PRAGMA = /PRAGMA\s+foreign_keys/i;

export function applyMigrations(db: Db, migrationsDir: string): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      filename   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const seen = new Set<number>(
    db
      .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const applied: string[] = [];
  for (const f of files) {
    const version = parseInt(f.slice(0, 4), 10);
    if (seen.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, f), "utf-8");
    const togglesForeignKeys = FOREIGN_KEYS_PRAGMA.test(sql);
    const tx = db.transaction(() => {
      db.exec(sql);
      if (togglesForeignKeys) {
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `migration ${f} left ${violations.length} foreign key violation(s); rolled back`,
          );
        }
      }
      db.prepare(
        "INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)",
      ).run(version, f, Date.now());
    });
    if (togglesForeignKeys) {
      db.pragma("foreign_keys = OFF");
      try {
        tx();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      tx();
    }
    applied.push(f);
  }
  return { applied };
}

/**
 * Locate the bundled migrations directory relative to the source tree.
 * Works for tsx (src/db.ts) and the compiled output (dist/db.js) —
 * backend/migrations sits one level up from either.
 */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations");
}
