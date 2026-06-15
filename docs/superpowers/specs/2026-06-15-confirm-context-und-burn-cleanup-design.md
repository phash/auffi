# Design: Confirm-Dialog-Kontext (Land) + Code-Burn-Cleanup

**Datum:** 2026-06-15
**Status:** Approved (Brainstorming) → next: writing-plans
**Auslöser:** Sicherheits-Frage des Nutzers ("Reicht der Code, oder brauchts ein Passwort?"). Analyse ergab: (B) der schwächste Punkt ist die menschliche Bestätigung, nicht die Code-Entropie → Confirm-Dialog mit mehr Kontext stärken; (A) die dokumentierte/beworbene "burned after 5 attempts"-Schutzmaßnahme feuert im Ad-hoc-Pfad faktisch nie.

Zwei unabhängige, getrennt committbare Arbeitsstränge in einem Spec, weil sie dieselbe Doku-/Claim-Fläche berühren.

---

## Teil A — Code-Burn entfernen + Doku & öffentliche Claims angleichen

### Root Cause

Im Ad-hoc-Join (`backend/src/signaling.ts`) kann ein Code nicht "fehlschlagen": Er matcht eine Session (→ `attachViewer`) oder ist unbekannt (→ kein Session-Objekt). `store.recordFailedAttempt(normalized)` wird nur im `!session`-Zweig aufgerufen (`signaling.ts:430`) und ist dort **immer** ein No-op (`recordFailedAttempt` returnt `false` für unbekannte Codes). Die Burn-nach-N-Logik (`codes.ts`) feuert daher in der Live-Path **nie**. Folgekette toter Code:

- `Session.failedAttempts`, `StoreConfig.maxAttempts`, `SessionStore.recordFailedAttempt()` (`codes.ts`).
- Der `burned`/`code-expired`-Error-Zweig (`signaling.ts:430–436`) — nur erreichbar bei `burned === true`, was nie eintritt.
- `code-expired` als Wire-Error-Code (`backend/src/protocol.ts`, `docs/protocol.md`) und seine komplette Viewer-Behandlung (`viewer/src/protocol.ts` Union, `viewer/src/connect-messages.ts` Mapping + `KNOWN_ERROR_CODES`, `viewer/src/i18n.ts` `join.codeExpired` DE+EN, `viewer/tests/connect-messages.test.ts`).

Der **echte** Ad-hoc-Brute-Force-Schutz ist: 10⁹ CSPRNG-Codes (`node:crypto`) + Per-IP-Rate-Limit (5/min, `rate-limit.ts` / `RATE_LIMIT_MAX`) + 10-min-TTL (`CODE_TTL_HARD_CAP_MS`) + **zwingende manuelle Bestätigung** durch den Sharer. Die echten "5 Fehlversuche → Lockout" liegen ausschließlich in den **Passwort**-Pfaden: `backend/src/auth/account_lockout.ts` (`ACCOUNT_PW_FAIL_THRESHOLD`) und der per-Device-Lockout in `unattended_sessions.ts`.

### Öffentliche Konsequenz (load-bearing!)

Die Behauptung "Code wird nach 5 Fehlversuchen serverseitig verbrannt" ist **heute schon faktisch falsch** und steht in 6 öffentlichen Dateien:

- `viewer/public/vergleich/anydesk/index.html` (DE Body + JSON-LD-FAQ `acceptedAnswer`)
- `viewer/public/vergleich/teamviewer/index.html` (DE Body + JSON-LD)
- `viewer/public/en/compare/anydesk/index.html` (EN Body + JSON-LD)
- `viewer/public/en/compare/teamviewer/index.html` (EN Body + JSON-LD)
- `viewer/public/datenschutz/index.html` (Datenschutz-Seite)
- `viewer/public/llms.txt`

**Entscheidung:** Burn entfernen UND die Claims auf die akkurate, wahre Story umschreiben (die zugleich ein stärkeres Argument ist).

### Änderungen

**Backend-Code-Entfernung:**
- `codes.ts`: `failedAttempts`, `maxAttempts`, `recordFailedAttempt()` + Burn-Logik raus.
- `signaling.ts`: `recordFailedAttempt`-Call + `burned`/`code-expired`-Zweig raus → unbekannter Code sendet schlicht `invalid-code`.
- `server.ts`: `maxAttempts`-Config aus `new SessionStore({...})` + `maxFailedAttempts`-Env + `MAX_FAILED_ATTEMPTS` raus (nur hier referenziert).
- `backend/src/protocol.ts`: `code-expired` aus dem `ErrorMessage`-Union raus.

**Viewer-Code-Entfernung (Konsistenz — sonst toter Handler):**
- `viewer/src/protocol.ts`: `code-expired` aus `ErrorMessage`-Union.
- `viewer/src/connect-messages.ts`: `case "code-expired"` + Eintrag in `KNOWN_ERROR_CODES`.
- `viewer/src/i18n.ts`: `join.codeExpired` (DE+EN).
- `viewer/tests/connect-messages.test.ts`: Test "maps a burned code" raus.

**Tests anpassen:**
- `backend/tests/codes.test.ts`: Burn-Tests + `maxAttempts`-Konstruktorargumente raus.
- `backend/tests/signaling.test.ts`, `backend/tests/turn-credentials.test.ts`: `maxAttempts`-Konstruktorargumente raus; Assertions auf `code-expired`/`burned`-Verhalten raus/anpassen.

**Öffentliche Claims — akkurate Ersatz-Copy:**

Kanonische Ersatzformulierungen (Detail-Wording pro Datei im Plan):

- *DE (Body/Liste):* „9-stelliger Verbindungscode, 10 Minuten gültig, serverseitig gegen Rateraten gedrosselt (Rate-Limit pro IP). Der Teilende bestätigt zudem jede Verbindung aktiv."
- *EN (Body/Liste):* „9-digit connection code, valid for 10 minutes, server-side rate-limited against guessing. The sharer also actively confirms every connection."
- *FAQ „How secure" / JSON-LD `acceptedAnswer`:* „Every stream is end-to-end encrypted with DTLS-SRTP (WebRTC). The 9-digit code expires after 10 minutes and the server rate-limits connection attempts; the sharer must actively confirm every connection. The server only brokers setup — video, mouse and files flow directly between the devices (peer-to-peer)." (DE analog.)
- *`datenschutz/index.html` + `llms.txt`:* „…nach 5 falschen Versuchen serverseitig verbrannt" → „…serverseitig gegen Rateraten gedrosselt (Rate-Limit pro IP)".

**Interne Doku-Korrektur:**
- `CLAUDE.md` (Product-Goal-3-Bullet: "server-burned after 5 wrong attempts").
- `docs/security-review-2026-05.md` (+ `-05-11`, `-05-14-feedback` falls sie es wiederholen).
- `docs/footguns.md` falls relevant; `docs/protocol.md` (`code-expired` raus).
- Test-Baseline-Zahlen in `CLAUDE.md` (Definition-of-Done) nach Netto-Test-Änderung nachziehen.

---

## Teil B — Land + Framing-Copy im Confirm-Dialog

### Ziel

Den menschlichen Bestätigungs-Schritt (das eigentliche Zugangstor) stärken: Herkunftsland + klare Warn-Copy, damit ein Laie eine unerwartete Verbindung leichter ablehnt.

### Scope-Grenzen (YAGNI)

- **Nur Ad-hoc-Confirm.** Der Unattended-Pfad bleibt unverändert (das Passwort *ist* dort das Tor; Land sekundär).
- Kein Datacenter/VPN-Flag. Kein Flag-Emoji (Windows rendert Regional-Indicator nicht als Flagge). Nur Land, keine Stadt.

### Datenfluss (4 Schichten)

1. **Backend `geoip.ts` (neu):** Lädt DB-IP-Lite-MMDB beim Start via `maxmind` (npm, MIT). API: `lookupCountry(ip: string): string | null` → ISO-3166-1-alpha-2 oder `null`. **Graceful Degradation:** Datei fehlt/unlesbar/Lookup-Fehler → einmalige Warn-Log → alle Lookups `null`; Signaling läuft normal weiter (Land ist nie load-bearing).
2. **`signaling.ts`:** An den beiden `peer-joined`-Stellen `country: null` → `country: geoip.lookupCountry(rawIp)`. Lookup nutzt die **volle** `req.ip` (nicht den Prefix). Das Land wird **nicht** geloggt/persistiert (kein neuer Eintrag in `connection_log`) — nur live an den Sharer für den Confirm.
3. **Rust `protocol.rs` + `signaling.rs`:** `ViewerInfo.country: Option<String>` mit `#[serde(default)]` (abwärtskompatibel zu Backends ohne Feld); Event-Emit `"peer-joined"` um `"country"` erweitern.
4. **Sharer `main.ts` + `index.html`:** Neuer **pure Helper** `formatConnectionRequest({ ipPrefix, country, trusted })` (testbar). ISO → deutscher Ländername via `Intl.DisplayNames(['de'], { type: 'region' }).of(iso)`; Fallback auf rohen ISO-Code, wenn `undefined`. Zweite Dialog-Zeile (`#confirm-warning`) für die Warn-Copy; in `aria-describedby` aufnehmen.

### Copy (DE)

- **Herkunft-Zeile:**
  - mit Land: `Verbindungsanfrage aus Deutschland · 84.xxx`
  - trusted: `… · bekannter Helfer (frühere Verbindung)`
  - ohne Land (Fallback = heutiges Verhalten): `Verbindungsanfrage von 84.xxx`
- **Warn-Zeile (immer):** „Erwartest du gerade eine Verbindung? Wenn dich niemand darum gebeten hat, lehne ab."

### MMDB-Delivery

- Download im Docker-Build, Monat als Build-ARG gepinnt (`DBIP_MONTH=YYYY-MM`), entpackt nach festem Pfad (z. B. `/app/data/dbip-country-lite.mmdb`).
- Build schlägt **laut** fehl, wenn der gepinnte Monat 404t (→ Roll-off wird bemerkt). Runtime degradiert **still**, wenn Datei fehlt.
- Lokal (`npm run dev`, ohne Docker) → Land deaktiviert, kein Problem.
- Monatlicher Bump in `docs/ops-runbook.md` dokumentiert.

### Lizenz (CC-BY-4.0)

- Attribution „IP Geolocation by DB-IP (https://db-ip.com), lizenziert unter CC-BY-4.0" in (a) Repo-`NOTICE`/Third-Party-Datei und (b) der bestehenden `viewer/public/impressum/index.html` (oder `datenschutz`).

### Tests (TDD, ≥70 %)

- **Backend `geoip.test.ts`:** echte Mini-Fixture-MMDB (per `mmdbwriter`-Dev-Script generiert, committed, in `.gitattributes` als `binary` markiert): bekannte IP → erwarteter ISO; private/ungültige IP → `null`; fehlende DB-Datei → `null` ohne Throw.
- **`signaling.test.ts`:** `peer-joined` trägt `country` aus injiziertem geoip-Lookup.
- **Rust:** `ViewerInfo`-Deserialize-Test mit und ohne `country`-Feld.
- **Sharer-js:** `formatConnectionRequest`-Tests (Land vorhanden / fehlt / trusted / ungültiges ISO → Fallback).

### Doku (Teil B)

- `docs/protocol.md`: `viewerInfo.country` jetzt befüllt (ISO-alpha-2 | null), Semantik.
- `docs/footguns.md`: geoip-Modul + MMDB-Delivery/Graceful-Degradation.
- `docs/ops-runbook.md`: monatlicher MMDB-Bump.
- `docs/security-review-2026-05.md`: Geo-Lookup ist lokal, keine IP an Dritte, kein PII-Log.

---

## Offene Verifikationspunkte (im Plan auflösen, nicht raten)

1. Genaue aktuelle Stable-Versionen von `maxmind` und `mmdbwriter` (`npm view <pkg> version`) — exakt pinnen.
2. Existenz/Struktur der `impressum`-Seite bestätigen (Attribution-Ziel) — existiert (`viewer/public/impressum/index.html`); genaues Markup beim Editieren prüfen.
3. `MAX_FAILED_ATTEMPTS` in `docker-compose*.yml` / `.env.example` / `ops/`-Skripten referenziert? Falls ja, dort mit entfernen.
4. Pro-Datei genaues Wording der 6 öffentlichen Claims (Body vs. JSON-LD) beim Editieren festlegen.
5. WebKitGTK-Version des Linux-Sharers für `Intl.DisplayNames`-Support (sonst greift der ISO-Fallback).

## Definition of Done

- Backend `npm test`, Sharer `cargo test --lib` + `cargo clippy -- -D warnings`, Viewer `npm test`, alle `tsc --noEmit` grün.
- Coverage ≥70 % für neuen Code (`geoip.ts`, `formatConnectionRequest`).
- Keine `code-expired`-Referenz mehr in Backend oder Viewer; keine `failedAttempts`/`maxAttempts`/`recordFailedAttempt` mehr.
- Öffentliche Security-Claims faktisch korrekt (6 Dateien + JSON-LD).
- Confirm-Dialog manuell smoke-getestet (Land sichtbar bei echter Verbindung; Fallback ohne MMDB).
- Atomare Conventional Commits, getrennt nach Teil A / Teil B.
