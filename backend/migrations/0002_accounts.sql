-- 0002_accounts.sql
--
-- Account + session + email-token tables for the unattended-access track.
-- Schema follows §3 of docs/superpowers/specs/2026-05-12-unattended-access-design.md.
-- Foreign keys are ON via pragma in openDb(); ON DELETE CASCADE on the
-- account-owned tables means a single hard-delete unwinds everything.

CREATE TABLE accounts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT NOT NULL,                          -- argon2id encoded string
    email_verified_at INTEGER,                                -- unix ms, NULL = unverified
    created_at        INTEGER NOT NULL,
    deleted_at        INTEGER                                 -- soft-delete marker
);

CREATE INDEX idx_accounts_deleted_at ON accounts(deleted_at);

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,                          -- 256-bit hex
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,                      -- sha256(cookie value)
    expires_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    user_agent_hint TEXT
);

CREATE INDEX idx_sessions_account_id ON sessions(account_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE email_verifications (
    token_hash TEXT PRIMARY KEY,                              -- sha256(token from mail link)
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

CREATE INDEX idx_email_verifications_account_id ON email_verifications(account_id);

CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,                              -- sha256(token from mail link)
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

CREATE INDEX idx_password_resets_account_id ON password_resets(account_id);
