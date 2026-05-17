-- Aggregierter Download-Counter pro GH-Release-Asset. Wird vom
-- /download/-Viewer per JS-Click ge-POSTet, vom selben Viewer per JS-
-- Load aller Counts ge-GETet. Kein User-Bezug, keine PII — reiner
-- "wie haeufig wurde was geklickt"-Counter zur Erfolgsmessung der
-- Marketing-Page.

CREATE TABLE download_counts (
  asset_name TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
