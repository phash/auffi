-- Fix the Migration-0005 widerspruch: audit_log.admin_id was declared
-- INTEGER NOT NULL REFERENCES accounts(id) ON DELETE SET NULL — the
-- NOT-NULL conflicts with the ON DELETE SET NULL action. SQLite would
-- crash on hard-delete of an admin account (DSGVO Art. 17 erasure or
-- soft-delete grace expiry) with a constraint violation, OR (worse)
-- leave the FK silently dangling depending on the SQLite version.
--
-- Make admin_id nullable so the SET NULL semantics work. The historical
-- "who did this action" is preserved as long as the account exists; after
-- account-deletion the audit row becomes "deleted admin did X" (still
-- useful: target_id + before/after_json + viewer_ip_prefix remain).
-- Tag any orphan rows that result with a stable marker via a follow-up
-- query in the app layer if needed.
--
-- Code-review DSGVO-M3 (2026-05-17).
--
-- NB: dieses PRAGMA war beim Ausrollen wirkungslos (SQLite ignoriert es
-- in einer offenen Transaktion, db.ts wickelt jede Datei in eine) —
-- harmlos, weil audit_log nur Kind-Tabelle ist. Seit 2026-09-02 wendet
-- applyMigrations das PRAGMA real an; siehe 0009 und docs/footguns.md.

PRAGMA foreign_keys = OFF;

CREATE TABLE audit_log_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id         INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    action           TEXT NOT NULL,
    target_type      TEXT NOT NULL,
    target_id        TEXT NOT NULL,
    before_json      TEXT,
    after_json       TEXT,
    created_at       INTEGER NOT NULL,
    viewer_ip_prefix TEXT
);

INSERT INTO audit_log_new
  (id, admin_id, action, target_type, target_id,
   before_json, after_json, created_at, viewer_ip_prefix)
SELECT
   id, admin_id, action, target_type, target_id,
   before_json, after_json, created_at, viewer_ip_prefix
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_admin_created ON audit_log(admin_id, created_at);
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id);

PRAGMA foreign_keys = ON;
