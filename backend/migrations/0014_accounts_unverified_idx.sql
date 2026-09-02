-- Der Retention-Purge löscht nie genutzte, unbestätigte Konten nach 7 Tagen
-- (purge.ts, unverifiedAccountsMs). Partieller Index, damit das Prädikat
-- proportional zu den gelöschten Zeilen bleibt statt die accounts-Tabelle
-- zu scannen — jede andere Purge-Sektion hat ihren Index schon.
CREATE INDEX idx_accounts_unverified_created_at
  ON accounts(created_at) WHERE email_verified_at IS NULL;
