-- 0005_admin.sql
--
-- Admin flag + suspended_at on accounts, plus an audit_log table for
-- traceability of admin actions (DSGVO compliance + abuse-postmortem).
-- Schema follows gh #41 (admin 1/16) acceptance criteria.

ALTER TABLE accounts ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;          -- NULL = active

CREATE INDEX idx_accounts_admin ON accounts(admin);
CREATE INDEX idx_accounts_suspended_at ON accounts(suspended_at);

CREATE TABLE audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE SET NULL,
    action           TEXT NOT NULL,                            -- e.g. "user.suspend"
    target_type      TEXT NOT NULL,                            -- "account" | "device"
    target_id        TEXT NOT NULL,                            -- string so it can hold device-id
    before_json      TEXT,                                     -- JSON of pre-mutation row
    after_json       TEXT,                                     -- JSON of post-mutation row
    created_at       INTEGER NOT NULL,
    viewer_ip_prefix TEXT                                      -- "84.xxx", admin's IP prefix
);

CREATE INDEX idx_audit_log_admin_created ON audit_log(admin_id, created_at);
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id);
