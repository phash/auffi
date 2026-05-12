-- 0004_devices.sql
--
-- Devices, pairing codes, connection log, and a small rate-limit bucket
-- table for per-device password-attempt lockout. Schema follows spec §3.

CREATE TABLE devices (
    id                TEXT PRIMARY KEY,                          -- 9-digit "NNN-NNN-NNN"
    owner_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    alias             TEXT NOT NULL,
    token_hash        TEXT NOT NULL,                             -- argon2(token)
    auto_accept       INTEGER NOT NULL DEFAULT 1,                -- bool
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER                                    -- updated on heartbeat (gh #15+)
);

CREATE INDEX idx_devices_owner_account_id ON devices(owner_account_id);
CREATE INDEX idx_devices_last_seen_at ON devices(last_seen_at);

CREATE TABLE device_pairings (
    code_hash  TEXT PRIMARY KEY,                                 -- sha256(pairing_code)
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,                                 -- now + 10min
    used_at    INTEGER
);

CREATE INDEX idx_device_pairings_account_id ON device_pairings(account_id);

CREATE TABLE connection_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    viewer_ip_prefix  TEXT NOT NULL,                             -- "84.xxx", never the full IP
    connection_type   TEXT NOT NULL,                             -- "p2p" | "relay"
    bytes_relayed     INTEGER NOT NULL DEFAULT 0                 -- 0 for p2p
);

CREATE INDEX idx_connection_log_device_id ON connection_log(device_id);
CREATE INDEX idx_connection_log_started_at ON connection_log(started_at);

-- Generic key→counter bucket used by the per-device password-attempt
-- lockout (gh #17 / spec §6). Key shape examples:
--   "device:123-456-789:pwfail"
--   "device:987-654-321:pwfail"
CREATE TABLE rate_limit_buckets (
    key          TEXT PRIMARY KEY,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER                                          -- unix ms; NULL = not locked
);
