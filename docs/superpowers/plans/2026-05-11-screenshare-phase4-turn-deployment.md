# Screenie Phase 4 — TURN + Free-Tier-Limits + Deployment (Outline)

> **Status:** Outline only. Wird detailliert, sobald Phase 3 läuft.

**Goal:** Production-Deployment auf IONOS VPS (MRD-Cluster). TURN-Relay für restriktive Netzwerke. Free-Tier-Limit (10 Min / 500 MB pro TURN-Session) als Monetarisierungs-Hook.

**Voraussetzungen aus Phase 3:** Komplette Funktionalität (Streaming + Input + Files) läuft lokal über STUN-basierten P2P-WebRTC.

## Architektur-Änderungen ggü. Phase 3

- **Neuer Komponenten:** coturn-Server (eigener Dienst).
- **Backend bekommt** `POST /turn-credentials`-Endpoint, der kurzlebige HMAC-Tokens ausgibt.
- **Sharer + Viewer**: Holen vor jeder Session TURN-Credentials und konfigurieren `RTCPeerConnection` mit ICE-Servern (eigener STUN+TURN).
- **Backend**: Mit echtem TLS (Let's-Encrypt via Nginx) auf `screenie.mr-development.de`.
- **Quota-Enforcement**: coturn-Lifetime + Bandwidth-Limits via `lifetime` und `max-bps`-Settings. Aus Sicht des WebRTC-Stacks beendet ein Lifetime-Cut die Session sauber (ICE wird disconnected) — Frontend zeigt Upgrade-Hinweis.

## Vorgesehene Tasks

### TURN-Server-Setup

1. **coturn auf IONOS VPS installieren.** Über MRD-Conventions/Cluster-Skill checken, welcher Port-Bereich frei ist. Standard: 3478 (UDP/TCP), 5349 (TLS).
2. **coturn-Config** (`/etc/turnserver.conf`):
   - `use-auth-secret` + langes Secret (geteilt mit Backend via Env-Var)
   - `realm=turn.screenie.mr-development.de`
   - `total-quota=100` (max gleichzeitige Sessions)
   - `user-quota=5000000` (~5 Mbit/s pro Session, in bps)
   - `max-bps=5000000`
   - `lifetime=600` (10 Min pro TURN-Allocation — Free-Tier-Limit!)
   - `cert=/etc/letsencrypt/live/turn.../fullchain.pem`
   - `pkey=/etc/letsencrypt/live/turn.../privkey.pem`
3. **DNS:** `turn.screenie.mr-development.de` A-Record auf VPS-IP.
4. **systemd-Service** für coturn, Auto-Restart, Logs nach journald.
5. **Smoke-Test:** `turnutils_uclient` von externem Rechner gegen Server, mit Test-Credentials.

### Backend-Erweiterung

6. **`POST /turn-credentials` Endpoint.** Generiert ephemerales Username/Password:
   - `username = <unix-timestamp + 3600>:<random-id>`
   - `password = base64(hmac-sha1(secret, username))`
   - Antwort: `{ urls: ["turn:turn...:3478", "turns:turn...:5349"], username, credential }`
7. **Rate-Limit auf `/turn-credentials`.** Max 10/Min/IP.
8. **Tests.** Backend-Test, dass generierte Credentials gegen lokales coturn validieren.

### Client-Integration

9. **Viewer + Sharer: TURN-Credentials abrufen** vor Session-Start. ICE-Servers konfigurieren.
10. **Telemetrie: P2P-vs-TURN-Detection.** Nach `iceconnectionstatechange`, beide Seiten loggen ob Verbindung "host"/"srflx" (P2P) oder "relay" (TURN) nutzt. Sharer schickt's via `relay` zum Viewer für Anzeige.
11. **UI-Hinweise:** Wenn TURN aktiv ist, zeigt Viewer + Sharer einen kleinen Indikator ("Verbindung über Relay"). Bei Minute 8 / 400 MB: gelber Warn-Toast. Bei Cut: roter Hinweis + Upgrade-Link.

### Free-Tier-Enforcement

12. **Lifetime-Cut beobachten.** coturn schließt TURN-Allocation nach `lifetime=600s`. Client sieht `iceconnectionstate=failed` oder `disconnected`. Frontend fängt das ab und zeigt Upgrade-Hinweis (nicht generischen Fehler).
13. **Bandbreiten-Limit testen.** Mit künstlich hoher Bitrate simulieren, dass `max-bps` greift. Erwartet: Bild ruckelt/komprimiert stark, statt sauber abzubrechen. Akzeptabel.
14. **TURN-Traffic-Reporting.** Tägliches Cron-Script parst coturn-Logs, summiert übertragene Bytes pro Tag, postet an MRD-API (`POST /clusters/.../status`).

### Deployment-Hardening

15. **Nginx als Reverse-Proxy** vor Backend. Let's Encrypt Cert für `screenie.mr-development.de`. WSS-Upgrade durchreichen.
16. **Backend als systemd-Service** mit Auto-Restart, Logs nach journald.
17. **Static Viewer-Build** unter `/var/www/screenie/`, von Nginx ausgeliefert.
18. **Sharer-Binaries hosten.** GitHub-Releases oder unter `/download` auf dem VPS. README für Erstinstallation pro OS.
19. **CI/CD:** GitHub Actions baut Tauri-Binaries für Linux + Windows. Auto-Upload zu Release.
20. **Health-Monitoring:** Cron pingt `screenie.mr-development.de/healthz` und `turn.screenie.mr-development.de:3478`. Bei Fehler: MRD-API-Status auf "degraded".

### Premium-Hook (vorbereiten, nicht aktivieren)

21. **DB-Schema (Postgres) für Premium-Accounts.** Tabelle `premium_keys` (api_key, expires_at). `POST /turn-credentials` akzeptiert optionalen `?key=` Parameter; bei gültigem Key wird `lifetime` in der HMAC-Username höher gesetzt (`+86400` = 1 Tag). coturn unterstützt das nativ über das eingebettete Lifetime.
22. **Stripe-Integration auf MRD-Seite** (außerhalb dieses Projekts) erzeugt Premium-Keys. Hier nur den Endpoint.

## Done When

- TURN-Server läuft auf `turn.screenie.mr-development.de` mit TLS.
- Eine Session aus restriktivem Netz (Mobile-Tethering mit Symmetric-NAT als Realtest) verbindet sich erfolgreich.
- Lifetime-Cut nach 10 Min sichtbar als sauberer Upgrade-Prompt.
- 500-MB-Cap durch `max-bps × lifetime` faktisch erreicht (Worst Case: 5 Mbit/s × 600s = 375 MB. Wenn 500 MB Ziel exakter sein soll: `lifetime=800s` und `max-bps=5000000`. Im echten Use-Case selten relevant, weil Lifetime früher greift.).
- `screenie.mr-development.de/healthz` liefert `{ status: "ok" }` über HTTPS.
- Sharer-Binaries (Linux + Windows) sind unter `/download` herunterladbar.
- Tägliches Traffic-Reporting an MRD-API funktioniert.
