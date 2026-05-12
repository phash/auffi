-- 0001_init.sql
--
-- First migration. Intentionally empty schema body — schema_migrations
-- is created by the runner itself before applying anything, so this
-- file exists purely so the runner has a record of "version 1 has been
-- applied" and the next migration's diff is unambiguous.
--
-- Subsequent migrations will create the auffi domain tables (accounts,
-- sessions, devices, connection_log, audit_log, …) as separate numbered
-- files — gh #10, #14, #41 in particular.

-- (no-op statement — SQLite requires at least one valid statement in
--  the file; a SELECT does nothing observable.)
SELECT 1;
