-- feedback.replied_by (0008/0009) referenzierte accounts(id) OHNE
-- ON-DELETE-Aktion. Mit foreign_keys=ON scheiterte damit jede
-- Konto-Löschung (DELETE /api/me, Admin-Delete) eines Kontos, das je eine
-- Feedback-Antwort geschrieben hat, mit einem 500 — DSGVO Art. 17 lief für
-- jeden antwortenden Admin ins Leere. ON DELETE SET NULL: die Antwort bleibt
-- beim Feedback (der Nutzer hat sie per Mail erhalten), nur der Verweis auf
-- das gelöschte Konto verschwindet.
--
-- SQLite kann eine FK-Aktion nicht per ALTER ändern, daher Table-Rebuild nach
-- dem Muster von 0009 (applyMigrations schaltet FKs für diese Datei außerhalb
-- der Transaktion ab und prüft foreign_key_check vor dem Commit).

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
  replied_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
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
