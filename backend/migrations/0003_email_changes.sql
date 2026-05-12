-- 0003_email_changes.sql
--
-- Pending email-change requests. PATCH /api/me with a new email creates a
-- row here and sends a verify link to the NEW address; the old email
-- remains active until the link is clicked. This decouples the initial
-- email_verifications table (one-shot, account creation) from the
-- recurring "change my email" flow — spec §4.6.

CREATE TABLE pending_email_changes (
    token_hash TEXT PRIMARY KEY,                           -- sha256(token from mail link)
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    new_email  TEXT NOT NULL COLLATE NOCASE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

CREATE INDEX idx_pending_email_changes_account_id ON pending_email_changes(account_id);
