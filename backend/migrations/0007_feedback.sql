-- Feedback aus Sharer + Dashboard. Nur eingeloggte Accounts (Dashboard
-- via Session-Cookie, Sharer via Device-Bearer-Token → owner_account_id
-- aus der devices-Tabelle).
--
-- Admin liest, filtert nach Status (offen/erledigt), kann pro Eintrag
-- als erledigt markieren oder loeschen (Spam/PII).

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'sharer')),
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'praise', 'other')),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  user_agent_hint TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Listenansicht ist nach Datum sortiert; resolved_at filtert offen/erledigt.
CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX idx_feedback_resolved_at ON feedback(resolved_at);
