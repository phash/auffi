-- Per-Code-Mint-Event mit Timestamp. Reine Aggregat-Statistik fuer
-- "wie oft wurde Auffi heute / diese Woche / diesen Monat benutzt".
-- KEINE PII: weder Code-Wert noch IP noch User-ID; nur ein
-- Millisekunden-Timestamp. Retention 365 Tage (analog audit_log) wird
-- vom purge.ts-Cron erledigt.

CREATE TABLE code_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_code_events_created_at ON code_events(created_at);
