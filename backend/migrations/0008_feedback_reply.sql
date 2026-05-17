-- Admin-Antwort auf Feedback (in-app reply, per E-Mail an User-Profil
-- gesendet). Vier zusaetzliche Spalten — alle nullable, weil ein Eintrag
-- ohne Reply der Default-Zustand ist.
--
-- replied_at = Admin hat im UI gesendet (= Speicher-Zeitpunkt der Antwort)
-- reply_sent_at = SMTP hat den Versand bestaetigt
-- Beides getrennt, damit ein transientes SMTP-Fehlschlag die Antwort als
-- Draft persistiert laesst (admin kann erneut triggern, ohne neu zu tippen).

ALTER TABLE feedback ADD COLUMN reply_body TEXT;
ALTER TABLE feedback ADD COLUMN replied_at INTEGER;
ALTER TABLE feedback ADD COLUMN replied_by INTEGER REFERENCES accounts(id);
ALTER TABLE feedback ADD COLUMN reply_sent_at INTEGER;
