-- "viewer" als dritte erlaubte Source einfuegen, damit der Floating-
-- Feedback-FAB auf den 4 Marketing-Seiten (/, /impressum/, /datenschutz/,
-- /download/) einen Eintrag mit unterscheidbarer Herkunft schreiben kann.
-- Sharer-/Dashboard-Pfade bleiben unveraendert; viewer authentifiziert
-- ueber dasselbe Session-Cookie wie dashboard.
--
-- SQLite kennt kein ALTER TABLE ... DROP CHECK; daher Table-Rebuild.
-- Reihenfolge folgt dem SQLite-FAQ: foreign_keys=OFF (sonst beisst
-- die ON-DELETE-CASCADE-Constraint beim DROP), neue Tabelle anlegen,
-- Daten kopieren, alte droppen, umbenennen, Indizes neu, foreign_keys
-- wieder an.

PRAGMA foreign_keys = OFF;

CREATE TABLE feedback_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'sharer', 'viewer')),
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'praise', 'other')),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  user_agent_hint TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  reply_body TEXT,
  replied_at INTEGER,
  replied_by INTEGER REFERENCES accounts(id),
  reply_sent_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT INTO feedback_new
  (id, account_id, source, category, rating, body, user_agent_hint,
   created_at, resolved_at, reply_body, replied_at, replied_by, reply_sent_at)
SELECT
  id, account_id, source, category, rating, body, user_agent_hint,
  created_at, resolved_at, reply_body, replied_at, replied_by, reply_sent_at
FROM feedback;

DROP TABLE feedback;
ALTER TABLE feedback_new RENAME TO feedback;

CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX idx_feedback_resolved_at ON feedback(resolved_at);

PRAGMA foreign_keys = ON;
