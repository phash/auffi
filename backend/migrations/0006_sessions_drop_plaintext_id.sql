-- 0006_sessions_drop_plaintext_id.sql
--
-- Sec C-1 (Review 2026-05-13): `sessions.id` stored the raw cookie
-- value alongside the (correctly-hashed) `token_hash`. The plain
-- column defeated the entire reason `token_hash` existed — anyone
-- with read access to the SQLite file could replay every live
-- session immediately. This migration drops the column and makes
-- `token_hash` the primary key.
--
-- Side effect: every existing session row is wiped — there's no
-- safe way to migrate plaintext tokens into hash-only storage
-- without recovering the cookie they belong to, and the threat
-- model treats those values as already-compromised. Users will be
-- prompted to log in again on the next request after the migration
-- runs. This is the intended one-time disruption.

DROP TABLE sessions;

CREATE TABLE sessions (
    token_hash      TEXT PRIMARY KEY,                          -- sha256(cookie value); never the cookie itself
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    user_agent_hint TEXT
);

CREATE INDEX idx_sessions_account_id ON sessions(account_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
