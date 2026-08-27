-- Soft-Delete war nie verdrahtet: kein Codepfad hat accounts.deleted_at je
-- gesetzt — Konten werden überall hart gelöscht (DELETE /api/me, Admin-Delete),
-- die FK-Cascades räumen Sessions/Devices/Logs mit ab. Spalte, Index und der
-- tote 30-Tage-Grace-Purge sind entfernt (Audit 2026-08-27); DSGVO-seitig ist
-- Sofort-Löschung ohnehin das kommunizierte Verhalten.
DROP INDEX idx_accounts_deleted_at;
ALTER TABLE accounts DROP COLUMN deleted_at;
