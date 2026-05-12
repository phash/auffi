# Unattended Access + Dashboard — Konzept

**Datum:** 2026-05-12
**Status:** Draft, in Review
**Autor:** Manuel + Claude (Brainstorming-Session)
**Bezug:** ergänzt [`2026-05-11-screenshare-design.md`](2026-05-11-screenshare-design.md) — der dortige Ad-hoc-Flow bleibt unverändert.

---

## 1. Ziel & Scope

Eine zweite Säule neben dem 9-stelligen Ad-hoc-Code: registrierte, dauer-erreichbare Geräte mit Passwort-Schutz. Use case: "Ich will von unterwegs auf meinen Heim-PC zugreifen, ohne dass jemand dort sitzt".

**Pflicht-Features (MVP):**
- Account-Anlage über E-Mail + Passwort, Verify-Mail-Flow
- Geräte mit dem Account verknüpfen (Pairing-Code)
- Pro Gerät ein vom Nutzer gesetztes Passwort, lokal am Sharer als argon2-Hash gespeichert
- Sharer hält im "Unattended-Modus" eine dauerhafte WSS-Verbindung zum Backend
- Viewer (logged-in **oder** anonym) verbindet sich mit Geräte-ID + Passwort
- Dashboard zeigt Geräte-Liste, Online-Status, Connection-Log, Account-Settings
- Self-Hosting bleibt mit einer zusätzlichen SQLite-Datei machbar

**Explizit Out-of-Scope (v1):**
- 2FA / TOTP (kann später hinzu)
- OAuth / SSO
- Mehrbenutzer-Sharing eines Gerätes ("Account A gibt Account B Zugriff")
- Mobile Sharer
- Audio, Recording, Chat
- Bezahlte Tiers (siehe Free-Tier-Entscheidung unten)

**Primäre Plattformen für den Sharer:** Linux, Windows. macOS-Code-Pfade bleiben kompilierbar, werden aber nicht getestet/garantiert.

**Free-Tier:** Komplett frei, kein hartes Limit im Code. Donation-Link im Dashboard-Footer. Bandwidth-Schutz nur über Backend-internes Rate-Limiting (für Missbrauch / DDoS-Schutz), nicht UI-sichtbar.

---

## 2. Architektur-Übersicht

```
                              Dashboard
                              (Vite/TS, neu)
                                    │
                                    │ HTTPS (Caddy)
                                    ▼
   Sharer ◄────── WSS persistent ────► Backend (Fastify + SQLite)
   (Tauri, im       (Token-auth,         │   │
    Unattended-     Pings 30s)           │   │
    Modus)                               │   │
                                         │   ▼
                                         │   accounts, devices,
                                         │   sessions, logs
                                         │
                                         ▼
                                       SMTP (Verify + Reset Mails)

   Viewer ◄────── WSS ad-hoc ─────────►
   (Browser)        (Code lookup)
                                    │
                                    ▼ optional
                              coturn (TURN-Fallback)
```

**Sicherheits-Modell — zwei Schichten:**

| Schicht | Schützt vor | Wie |
|---|---|---|
| **Sharer ↔ Backend: Long-Lived-Token** | Spoofing fremder Geräte unter meinem Account | 256-bit Random, in Tauri Secure Storage; Backend kennt nur `argon2id(token)`; revokebar im Dashboard |
| **Viewer ↔ Sharer: Geräte-Passwort** | Unbefugter Connect (Backend-Compromise oder ID-Leak) | Argon2-Hash lokal am Sharer; Plaintext durchläuft Backend nur kurz im RAM, wird nicht geloggt/gespeichert; Brute-Force durch globalen Rate-Limit pro Device + lokales Lockout am Sharer abgesichert |

Konsequenzen:
- **Backend-Compromise** gibt Angreifer Zugriff auf Liste der Geräte-IDs, aber nicht auf die Geräte selbst (PW fehlt).
- **Token-Diebstahl** allein reicht nicht (kein PW).
- **PW-Bruteforce** gegen einen Sharer wird nach 5 Fehlversuchen 15 min global gesperrt (Backend) plus 1 h lokal (Sharer).

---

## 3. Datenmodell (SQLite)

WAL-Modus, `better-sqlite3` (synchron). Eine Datei `/var/lib/screenie/screenie.db` im Docker-Volume.

```sql
accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,                     -- argon2id
    email_verified_at INTEGER,                       -- unix ms, NULL = unverified
    created_at    INTEGER NOT NULL,
    deleted_at    INTEGER                            -- soft delete (purge cron 30d)
);

sessions (
    id           TEXT PRIMARY KEY,                   -- random 256-bit hex
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,                      -- sha256(cookie value)
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent_hint TEXT                             -- truncated UA for "active sessions" later
);

email_verifications (
    token_hash TEXT PRIMARY KEY,                     -- sha256 of mail link token
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

password_resets (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);

devices (
    id              TEXT PRIMARY KEY,                -- 9-stellig, e.g. "123-456-789"
    owner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    alias           TEXT NOT NULL,
    token_hash      TEXT NOT NULL,                   -- argon2(device_token)
    auto_accept     INTEGER NOT NULL DEFAULT 1,      -- bool
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER                          -- updated on heartbeat
);

device_pairings (
    code_hash  TEXT PRIMARY KEY,                     -- sha256(pairing_code)
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,                     -- now + 10min
    used_at    INTEGER
);

connection_log (
    id                INTEGER PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    viewer_ip_prefix  TEXT NOT NULL,                 -- e.g. "84.xxx"
    connection_type   TEXT NOT NULL,                 -- "p2p" | "relay"
    bytes_relayed     INTEGER NOT NULL DEFAULT 0     -- 0 for p2p
);

rate_limit_buckets (
    key          TEXT PRIMARY KEY,                   -- "device:123-456-789:pwfail"
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER                             -- unix ms; NULL = not locked
);
```

**Retention:**
- `connection_log` älter als 30 Tage → cron-purge täglich
- `sessions` mit `expires_at < now` → cron-purge täglich
- `device_pairings`, `email_verifications`, `password_resets` älter als ihre `expires_at` → cron-purge täglich
- `accounts` mit `deleted_at < now - 30d` → hard-delete (cascade alles)

**DSGVO:**
- E-Mail ist PII, wird nie geloggt; in DB als Klartext (für Reset-Flow nötig)
- Account-Löschung im Dashboard ist sofortige Hard-Delete (`DELETE FROM accounts ...`), Cascade entfernt alles Verknüpfte
- IP-Prefix im Log nie volle IP

---

## 4. Auth-Flows

### 4.1 Signup
1. `POST /api/auth/signup { email, password }`
2. Backend: argon2-Hash erstellen, `accounts`-Row mit `email_verified_at = NULL` einfügen
3. Backend: 256-bit Token generieren, `sha256(token)` in `email_verifications`, TTL 24h
4. Backend: SMTP-Mail mit Link `https://screenie.mr-development.de/dashboard/verify/<token>`
5. Frontend: Success-Toast "Bestätigungs-Mail gesendet"

### 4.2 Verify
1. `GET /api/auth/verify/:token`
2. Backend: sha256 lookup → setzt `email_verified_at = now`, markiert Token als used, erstellt Session-Cookie
3. Frontend: Redirect zu `/` (devices list)

### 4.3 Login
1. `POST /api/auth/login { email, password }`
2. Backend: Rate-Limit-Check (5/min pro IP)
3. Backend: argon2-Verify gegen `password_hash` (auch wenn email nicht existiert — gleiche Dauer, timing-attack mitigation)
4. Erfolg: 256-bit Session-Token generieren, `sha256(token)` in `sessions`, Cookie setzen (`HttpOnly`, `Secure`, `SameSite=Strict`, 30d TTL)
5. Frontend: Redirect zu `/`

### 4.4 Logout
- `POST /api/auth/logout` → Session-Row löschen, Cookie expire setzen

### 4.5 Forgot Password
1. `POST /api/auth/forgot { email }` → immer 200 zurück (kein Account-Existence-Leak)
2. Falls Account: Token in `password_resets` (TTL 1h), SMTP-Mail mit Link
3. `POST /api/auth/reset/:token { password }` → setze neuen Hash, lösche **alle** Sessions des Accounts (Sicherheit), markiere Token als used

### 4.6 E-Mail ändern
- `PATCH /api/me { current_password, new_email }` → re-verify-flow auf die NEUE Adresse; alte E-Mail bleibt aktiv bis Klick auf neue Verify-Mail

### 4.7 Account löschen
- `DELETE /api/me { current_password, confirm: "LÖSCHEN" }` → sofortige Hard-Delete (Cascade)
- Sharer-Geräte verlieren ihren Token → beim nächsten Heartbeat antwortet Backend `401`, Sharer fällt in Ad-hoc-Modus zurück

---

## 5. Device-Pairing

### 5.1 Initiierung (Dashboard)
1. Im Dashboard: "Neues Gerät" klicken
2. `POST /api/devices/pairing-code` (auth: session)
3. Backend: 8-stellig alphanumerisch (z.B. `7K3-9PQ-XR`) generieren, `sha256` in `device_pairings`, TTL 10 min
4. Frontend: Modal mit Code + Anleitung "Im Sharer-Settings → Pairing-Code eingeben"

### 5.2 Einlösung (Sharer)
1. User aktiviert Unattended-Modus, klickt "Mit Account verbinden"
2. Code eingeben → `POST /api/devices/redeem { code }`
3. Backend: sha256-Lookup, validate, markiert Pairing als `used_at = now`
4. Backend: generiert 9-stellige Device-ID (collision-check), 256-bit Device-Token, `argon2id` Hash → `devices` Row insert
5. Backend antwortet: `{ device_id, token }` (Klartext-Token nur in dieser Response, danach nie wieder)
6. Sharer speichert Token in Tauri Secure Storage; speichert Device-ID in normaler Config (nicht sensitiv)
7. Sharer-UI prompt: "Geräte-Passwort festlegen" (min 8 Zeichen, keine Komplexitätsregeln über Min-Länge hinaus — Passphrasen sollen erlaubt sein)
8. Sharer speichert `argon2id(device_password)` in lokaler Config-Datei (separater Pfad von Token, damit User PW-only-reset machen kann ohne Re-Pairing)

### 5.3 Verbinden des Sharers
- Beim Start (oder beim Aktivieren des Modus): WSS-Connect zu `wss://backend/signal`, `Authorization: Bearer <token>`
- Backend: argon2-verify gegen `devices.token_hash` (Lookup über Device-ID aus Subprotokoll-Header), bei Erfolg → `last_seen_at = now`, Device gilt als online
- Heartbeat: alle 30s ein PING; nach 90s ohne PONG seitens Backend → Sharer reconnect mit exponential backoff (1s, 2s, 4s, …, max 60s)

---

## 6. Connect-Flow (Viewer → Unattended-Sharer)

```
Viewer eingibt "123-456-789"
        │
        │ WS JOIN { code }
        ▼
Backend Lookup:
   1. Active ad-hoc session?   → bestehender Flow (Sharer-Klick)
   2. Registered device?        → unattended path (s.u.)
   3. Nichts                    → { error: "unknown_code" }
        │
        ▼ (unattended)
Backend: rate-limit-bucket prüfen (device:id:pwfail)
   gesperrt → { error: "locked", retry_after: 850s }
        │
        ▼
Backend → Viewer: { kind: "needs_password" }
        │
        ▼
Viewer-UI: PW-Prompt
        │
        │ WS RELAY { kind: "pw-attempt", password }
        ▼
Backend → Sharer (via dessen WSS): { kind: "pw-check", attempt }
        │
        ▼
Sharer: argon2-verify lokal
   ✗ → Sharer → Backend: { kind: "pw-fail" }
        Backend: rate_limit_buckets[device:id:pwfail].fail_count++
        wenn ≥5: locked_until = now + 15min
        Backend → Viewer: { error: "wrong_password", attempts_left: N }
   ✓ → Sharer: auto_accept-Check
        - auto_accept = true: weiter
        - auto_accept = false: Sharer zeigt Confirm-Toast (60s Timeout),
          User klickt Akzeptieren/Ablehnen
        Sharer → Backend: { kind: "pw-ok" } oder { kind: "pw-rejected-by-user" }
        Backend: rate_limit_buckets[device:id:pwfail].fail_count = 0
        Backend stellt Sharer + Viewer in derselben Signaling-Group zusammen
        → bestehender WebRTC Offer/Answer/ICE Flow (unverändert)
```

**Lokales Lockout am Sharer (zusätzlich zum Backend):**
- Sharer zählt Fehlversuche selbst
- Bei 10 Fails in 5 min: 1h-Lokal-Lockout, ignoriert weitere `pw-check`-Requests, zeigt Tray-Notification "10+ Login-Versuche, vorübergehend gesperrt"

---

## 7. Sharer-Änderungen

### 7.1 Modus-Toggle
- Settings-Seite (neue Tauri-Webview-Route oder Tab in bestehendem Window) mit Radio-Buttons: "Ad-hoc-Hilfe" (default) / "Unattended-Zugriff"
- Wechsel zu Unattended fordert Pairing + Passwort. Wechsel zurück: Token wird revoked am Backend, lokal gelöscht.

### 7.2 Neue Rust-Module
- `account.rs` — Pairing-Code einlösen, Token in Keyring schreiben/lesen, Token-Revoke
- `device_password.rs` — argon2id set / verify, Config-File-IO
- `heartbeat.rs` — Async-Loop für WSS-Ping, Reconnect-State

### 7.3 Neue Tauri-Plugins
- `tauri-plugin-autostart` — registriert Bootstrap-Eintrag plattformspezifisch
- Tray-Icon (Tauri 2 core API): rechts-klick öffnet Status + "Beenden"

### 7.4 Tray-Verhalten
- Im Unattended-Modus minimiert App in Tray statt zu beenden bei Window-Close
- Tray-Tooltip zeigt: "Screenie · 🟢 Online · ID 123-456-789"
- Right-Click-Menü: "Fenster zeigen", "Status: Online/Offline", "Geräte-ID kopieren", "Quit"

### 7.5 Anbindung im Ad-hoc-Modus
- Bestehender Code unverändert. Modus-Toggle setzt nur, ob die WSS persistent gehalten wird und ob `pw-check`-Handler aktiv ist.

---

## 8. Dashboard-UI

### 8.1 Routen
- `/login`, `/signup`, `/verify/:token`, `/forgot`, `/reset/:token` (öffentlich)
- `/` (Geräte-Liste, Default nach Login), `/devices/:id` (Detail), `/settings` (Account), `/logout` (POST → /login)

### 8.2 Tech-Entscheidungen
- Separates Paket `dashboard/` (parallel zu `viewer/`, `sharer/`)
- Vite + TS, kein Framework, eigener winziger History-Router
- Wiederverwendung des viewer/-Footers und der CSS-Variablen (--accent, --bg, --card-bg, dark-mode-Vars)
- Kein Tracker, kein CDN-Asset — alles selbst gehostet

### 8.3 Geräte-Liste
- Tabelle: Online-Dot, Alias (klickbar → Detail), Geräte-ID, "Verbinden ▶" (öffnet Viewer-URL `/?code=…` in neuem Tab), ⋮-Menü
- "+ Neues Gerät"-Button rechts oben → Modal mit Pairing-Code

### 8.4 Geräte-Detail
- Alias (inline-edit, Auto-Save bei Blur)
- Online-Status + Last-Seen
- Auto-Accept-Toggle
- Connection-Log (Tabelle, 20 pro Seite, Cursor-pagination): Timestamp, IP-Prefix, Dauer, p2p/relay, Bytes (nur relay)
- "Gerät entkoppeln"-Button (Confirm-Modal)

### 8.5 Account-Settings
- E-Mail anzeigen
- "E-Mail ändern" (Modal: aktuelles PW + neue E-Mail)
- "Passwort ändern" (Modal: aktuelles + neues PW)
- "Account löschen" (Modal: aktuelles PW + "LÖSCHEN" tippen, Disclaimer)

### 8.6 Donation / Self-Hosting im Footer
- Reuse des viewer/-Footers, aber mit Dashboard-spezifischem Zusatz: "Selbst hosten" → `https://phash.de/screenie/` und "Donate ☕" → `https://buymeacoffee.com/phash`

---

## 9. Backend-API (Fastify-Routen)

| Methode + Pfad | Auth | Rate-Limit | Body / Response |
|---|---|---|---|
| `POST /api/auth/signup` | none | 3/h/IP | `{email, password}` → 202 |
| `GET  /api/auth/verify/:token` | none | 10/h/IP | redirect |
| `POST /api/auth/login` | none | 5/min/IP | `{email, password}` → 200 + Cookie |
| `POST /api/auth/logout` | session | — | 204 |
| `POST /api/auth/forgot` | none | 3/h/IP | `{email}` → 202 |
| `POST /api/auth/reset/:token` | none | 5/h/IP | `{password}` → 204 |
| `GET  /api/me` | session | — | `{email, created_at, …}` |
| `PATCH /api/me` | session | 10/h | `{current_password, new_email?, new_password?}` |
| `DELETE /api/me` | session | 3/h | `{current_password, confirm}` → 204 |
| `GET  /api/devices` | session | — | `[{id, alias, online, last_seen_at, auto_accept}, …]` |
| `POST /api/devices/pairing-code` | session | 5/h | → `{code, expires_at}` |
| `POST /api/devices/redeem` | none (sharer) | 5/min/IP | `{code, alias}` → `{device_id, token}` |
| `PATCH /api/devices/:id` | session + owner | — | `{alias?, auto_accept?}` |
| `DELETE /api/devices/:id` | session + owner | — | 204 |
| `GET  /api/devices/:id/log` | session + owner | — | `{items, next_cursor}` |
| WS `/signal` | (existing) | (existing) | Erweitert um Sharer-Auth via `Authorization: Bearer <token>` Header beim Upgrade |

**Neue WSS-Nachrichten** (top-level `type` field):
- `needs_password` (Backend → Viewer): Code referenziert ein Device, kein Ad-hoc
- `pw-attempt` (Viewer → Backend): `{password}`
- `pw-check` (Backend → Sharer): `{attempt, attempt_id}`
- `pw-ok`, `pw-fail`, `pw-rejected-by-user` (Sharer → Backend): `{attempt_id, …}`
- `pw-locked` (Backend → Viewer): `{retry_after_ms}`

---

## 10. Self-Hosting

Neue `docker-compose.prod.yml`-Services bzw. Volumes:

```yaml
backend:
  # ...
  volumes:
    - screenie-data:/var/lib/screenie  # SQLite-Datei

volumes:
  screenie-data:
```

Neue env-vars im `.env.prod`:
```
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Screenie <no-reply@…>"
DASHBOARD_BASE_URL=https://screenie.mr-development.de/dashboard
SIGNUP_DISABLED=false   # falls self-hoster Anmeldung sperren will
```

Caddy: zusätzlicher Block für `/dashboard/*` → serve static aus dem dashboard-build, `/api/*` → reverse_proxy backend.

---

## 11. Tests / Verifikation

Per CLAUDE.md TDD-Pflicht, ≥70 % Coverage. Pro Modul:

**Backend (Vitest + Fastify-inject):**
- Auth-Flows: signup happy-path, double-signup, login-falsch-pw timing, reset-token-expire, reset-token-reuse
- Devices: pairing-code TTL, redeem-zweimal verboten, owner-only-access auf PATCH/DELETE
- Connect-Flow: code-lookup-priorität (ad-hoc vs device), pw-fail-counter, lockout
- Cron-Purge: 30d-Cleanup
- DSGVO: account-delete cascade

**Sharer (Cargo Tests):**
- argon2 set + verify roundtrip
- Token-Lifecycle: pair, revoke, re-pair
- Local-Lockout-Counter
- Heartbeat-Reconnect-Logic (mit mock WS)

**Dashboard (Vitest + happy-dom oder jsdom):**
- Router-Navigation
- Form-Validierung (E-Mail-Format, PW-Min-Länge)
- API-Mocks für jeden Endpoint

**E2E (Playwright):**
- Signup → Verify → Login → Add-Device → (Mock-Sharer) → Connect → Disconnect
- Forgot → Reset → Login mit neuem PW
- Account-Delete → alle Devices weg

---

## 12. Migration / Rollout

- Bestehende ad-hoc User: **null Änderung**. Default-Modus bleibt ad-hoc, neue Settings-Seite ist opt-in.
- Backend deploy: SQLite-Migration v1 erstellt alle Tabellen leer, kein Daten-Migrationsschritt nötig (Ad-hoc nutzt bisher kein Persistent State).
- Dashboard: neue Route unter `/dashboard/*`, ändert nichts am Viewer-Pfad `/`.
- Sharer-Update: neue Settings-Seite, alte UI bleibt für Ad-hoc unverändert. User muss nichts tun, kann aber neue Funktion aktivieren.

---

## 13. Issue-Aufteilung (Vorschlag für GitHub Issues)

Jedes Issue ist self-contained, ~1-3 Tage Arbeit. Reihenfolge entspricht Implementierungs-Abhängigkeiten.

1. **Backend: SQLite-Setup + Migrations-Runner**
2. **Backend: Account-Modul (signup, verify, login, logout, forgot, reset)**
3. **Backend: SMTP-Adapter + Verify-/Reset-Mail-Templates**
4. **Backend: Session-Middleware + Rate-Limiter pro Auth-Endpoint**
5. **Backend: Account-Settings-Endpoints (PATCH /me, DELETE /me)**
6. **Backend: Device-Modul (pairing-code mint + redeem, devices list)**
7. **Backend: Device-PATCH/DELETE + Owner-Auth-Middleware**
8. **Backend: WSS-Erweiterung — Sharer-Auth über Bearer-Token beim Upgrade**
9. **Backend: WSS-Erweiterung — Unattended-Connect-Flow (needs_password, pw-attempt, pw-check, lockout)**
10. **Backend: Connection-Log-Persistierung + GET-Endpoint mit Cursor-Pagination**
11. **Backend: Cron-Purge (sessions, pairings, verifications, resets, connection_log, soft-deleted accounts)**
12. **Sharer: Modus-Toggle in Settings + Persistierung (tauri-plugin-store)**
13. **Sharer: Pairing-Flow (Code einlösen, Token in Secure Storage)**
14. **Sharer: Device-Password set/verify (argon2 in Config-File)**
15. **Sharer: Persistente WSS + Heartbeat + Reconnect**
16. **Sharer: `pw-check`-Handler mit Local-Lockout-Counter**
17. **Sharer: Auto-Accept-Modus + Manuelle-Confirm-Modus**
18. **Sharer: Tray-Icon + Minimieren-Verhalten**
19. **Sharer: Autostart-Toggle (tauri-plugin-autostart)**
20. **Dashboard: Vite-Setup + Router + CSS-Variablen aus viewer/ wiederverwenden**
21. **Dashboard: Login + Signup + Verify-Seiten**
22. **Dashboard: Forgot- + Reset-Password-Seiten**
23. **Dashboard: Geräte-Liste (Default-View nach Login)**
24. **Dashboard: Add-Device-Modal mit Pairing-Code**
25. **Dashboard: Geräte-Detail mit Alias-Edit + Auto-Accept-Toggle**
26. **Dashboard: Connection-Log-Ansicht**
27. **Dashboard: Account-Settings (E-Mail/PW/Löschen)**
28. **Viewer: PW-Prompt-UI für Unattended-Code, `needs_password`-Message-Handler**
29. **Viewer: Pre-fill `?code=...` aus URL-Query-Param (für Dashboard "Verbinden"-Button)**
30. **Ops: Caddyfile-Block für /dashboard/* + /api/*, SQLite-Volume in compose**
31. **Ops: SMTP-Konfiguration im Env-Template, docs/INSTALL.md aktualisieren**
32. **E2E: Playwright-Test für kompletten Unattended-Roundtrip**

---

## 14. Offene Punkte / Bewusst gestrichen

- **2FA / TOTP**: zurückgestellt, kann nach v1 ergänzt werden
- **Mehrbenutzer-Sharing**: zurückgestellt
- **Mobile-Sharer**: kein Aufwand in v1
- **Tray-Icon auf Linux**: Plattformkapazität testen, ggf. mit AppIndicator/StatusNotifierItem; falls problematisch → nur Window minimieren statt Tray
- **Free-Tier-Timer entfernen?**: Der bestehende 10-min-Relay-Cutoff aus dem Ad-hoc-Spec greift heute auch im Unattended-Fall. Entscheidung: in v1 für Unattended **deaktivieren**, da "primär kostenlos + Donation" gewählt wurde; im Ad-hoc-Modus belassen wir ihn vorerst. Wird im Issue für WSS-Erweiterung präzisiert.
