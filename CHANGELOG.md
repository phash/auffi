# Changelog

Alle nennenswerten Änderungen an Auffi werden in dieser Datei dokumentiert.

Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) und das
Projekt nutzt [Semantic Versioning](https://semver.org/lang/de/).

## [0.6.3] — 2026-06-22

### Behoben

- **Flüssigere Übertragung auf Windows ohne GPU / über Remotedesktop.** Der
  VP8-Encoder lief mit der langsamsten Bewegungssuche (cpu-used=0) und kam beim
  Software-Encoding eines ganzen Desktops auf GPU-losen Hosts nicht hinterher —
  das Bild ruckelte stark. Encoder jetzt auf Echtzeit getrimmt
  (`VP8E_SET_CPUUSED=8`, `VPX_CBR`, geringe Latenz). Das „alive"-Diagnose-Log
  nennt zusätzlich effektive FPS + mittlere Encode-Zeit zur weiteren Analyse.

## [0.6.2] — 2026-06-22

### Behoben

- **Windows-Bildschirmaufnahme schlug fehl.** Der 0.6.0-Windows-Build brach mit
  „Streamen konnte nicht gestartet werden" ab (`E_NOINTERFACE`), weil der
  Capture-Worker-Thread kein initialisiertes COM/WinRT-Apartment hatte. Fix:
  `CoInitializeEx(MTA)`-RAII-Guard auf dem Capture-Thread + GDI-BitBlt-Fallback
  für RDP / Hosts ohne GPU (inkl. 3-s-First-Frame-Probe, ab der WGC als
  unbrauchbar gilt).

### Sicherheit

- **Diagnose-Log gehärtet** — auf Unix mit `O_NOFOLLOW` + Mode `0600` atomar
  angelegt (kein Symlink-Redirect, kein Mitlesen durch andere lokale Nutzer).
- **TURN-URLs redacten IP-Literale** vor dem Logging (keine Relay-Infra-Preisgabe).
- **GDI-Capture-Härtung** — als `!Send` markiert, `checked_mul` auf die
  Frame-Buffer-Größe, `SelectObject`-`HGDI_ERROR`-Check; Dateiübertragung
  schützt Windows-Reserved-Names (CON/NUL/COM1…).

### Geändert

- **Code-Ablauf-UX** — ein vollständiger Teardown (Beenden) gibt den Ad-hoc-Code
  frei und entfernt ihn vom Bildschirm; ein reiner Viewer-Wechsel behält ihn.
  Der Sekunden-Countdown spammt Screenreader nicht mehr (`aria-live` entfernt).

## [0.6.0] — 2026-06-16

### Hinzugefügt

- **Land des Zuschauers im Bestätigungsdialog** — beim Ad-hoc-Verbinden zeigt
  der Sharer das Land der anfragenden Person an (optionaler GeoIP-Lookup).

### Geändert

- **„Calm Fresh"-Design** für die Sharer-Oberfläche (emerald/mint, AA-Kontrast
  in hell und dunkel), plus Härtungen (kein IP-basiertes Auto-Akzeptieren,
  Cleartext-URL-Schutz) und aktualisierte Abhängigkeiten. Linux + Windows über
  die Release-CI; macOS weiterhin nicht gebaut.

## [0.5.0] — 2026-05-29

Bündelt die Ergebnisse eines Security- und UX-Reviews.

### Sicherheit

- **TURN-Relay-SSRF geschlossen.** coturn verweigert jetzt Relays zu allen
  Special-Use-/Private-Bereichen (RFC1918, Loopback, Link-Local inkl.
  Cloud-Metadata `169.254.169.254`, CGNAT, IPv4-mapped IPv6) — ein Client mit
  TURN-Credentials kann den Relay nicht mehr als internen Port-Scanner gegen
  Backend, Matomo oder Nachbar-Container missbrauchen.
- **`X-Forwarded-For`-Spoofing entschärft.** Das Backend traut nur noch genau
  einem Proxy-Hop (`trustProxy: 1` statt `true`), damit eine gefälschte
  XFF-Kette die Per-IP-Rate-Limits nicht aushebeln kann.
- **Feedback-Endpoint gegen argon2-DoS gehärtet.** Der Sharer-Bearer-Pfad von
  `POST /api/feedback` hat ein eigenes, engeres Per-IP-Limit vor dem
  argon2-Verify (analog zum Signaling-Bearer-Cap).

### Geändert

- **Viewer: verständliche Fehlermeldungen statt Roh-Codes.** Falscher/
  abgelaufener Code, gesperrter Code, abgelehnte Anfrage usw. erscheinen jetzt
  als deutscher Klartext mit Handlungspfad statt `Fehler: invalid-code …`.
- **Viewer: kein Endlos-Spinner mehr.** Ein Connect-Timeout (mit Firewall-
  Hinweis, wenn kein Relay erreichbar war) und ein sichtbarer
  „Abbrechen"-Button geben immer einen Ausweg aus „Warte auf Bestätigung…".
- **Downloads auf der Startseite laufen über den Proxy.** Die Windows-Buttons
  zeigen nicht mehr direkt auf GitHub (keine IP an Dritte, server-seitiger
  Zähler) — konsistent mit der `/download/`-Seite.

### Behoben

- Defekter „Setup-Installer"-Link auf der Startseite (zeigte auf ein nicht
  existierendes Asset → 404).
- Zwei latente Typfehler im Sharer-Webview (nie typgeprüft, da der Build via
  esbuild läuft).

### Intern

- Geteilter Per-IP-Rate-Limiter (`rate-limit.ts`), CI-Jobs für Dashboard +
  Sharer-Webview, `tsc --noEmit`-Gates, Dashboard-Coverage-Tooling,
  Sharer-`tsconfig.json`, Entfernung veralteter `dead_code`-Allows,
  Protokoll-Doku für den Unattended-Flow.

## [0.4.5] — 2026-05-21

### Hinzugefügt

- **Update-Notifier im Sharer.** Beim App-Start ein einmaliger Check
  gegen die GitHub-Releases-API; wenn eine neuere Version verfügbar
  ist, erscheint ein blauer Banner mit Link auf
  [auffi.app/download/](https://auffi.app/download/). Bei Netzwerk-
  oder Parse-Fehler bleibt der Banner versteckt — kein „konnte nicht
  prüfen"-Toast.
- **Download-Proxy via `auffi.app`.** Statt auf GitHub-Releases zu
  redirecten, streamt der Backend die Asset-Bytes direkt durch (Route
  `/api/downloads/file/:asset`, optional `?tag=vX.Y.Z` zum Pinnen). Per-
  Version-Counter inkrementiert serverseitig — kein Client-JS-Hop mehr.

### Behoben

- **HEAD-Requests bumpen den Download-Counter nicht mehr** und fetchen
  den Upstream nicht. Link-Preview-Crawler und Uptime-Checks zählen
  jetzt nicht mehr als echte Downloads.

## [0.4.4] — 2026-05-20

### Behoben

- **Windows: Cursor-Flicker eliminiert.** Die System-Cursor flackerte
  sichtbar, sobald ein Viewer verbunden war. Ursache war eine pro Frame
  neu geöffnete WGC-Capture-Session (~30/s), die DWMs Cursor-Compositing
  fortlaufend umschaltete. Jetzt eine persistente Capture-Session pro
  Stream-Lifetime.
- **Sauberes Capture-Stopp** auf Windows und Linux/X11. Nach dem Trennen
  blieb der Capture-Thread weiterlaufen, bis der Sharer komplett beendet
  wurde. Stop-Signal wird jetzt zuverlässig innerhalb von ≤500 ms erkannt.

### Geändert

- Windows-Asset-Naming wechselt auf das Tauri-Standard-Schema
  (`Auffi_0.4.4_x64-setup.exe` und `Auffi_0.4.4_x64_en-US.msi` statt der
  bisherigen `auffi-sharer-windows-x64-*.exe`).

## [0.4.3] — 2026-05-20

### Hinzugefügt

- **Markanter „Verbinden"-Notch** oben mittig auf der Website (#104).
  Springt auf der Hauptseite per Klick mit weichem Scroll + Fokus zur
  Code-Eingabe; auf den Marketing-Subpages (Impressum, Datenschutz,
  Download) führt der Notch zurück zur Startseite und fokussiert dort
  den Code-Input.

## [0.4.2] — 2026-05-17

### Sicherheit

- **8 transitive CVEs in der TLS-Stack gepatcht** (RUSTSEC-2026-0046 /
  0047 / 0048 / 0049 / 0098 / 0099 / 0104). Drei High-Severity (Cert-
  Chain-Bypass, Signatur-Bypass, CRL-Logik in aws-lc) und vier Medium
  in rustls-webpki (Name-Constraints, CRL-Panic). Empfohlen für alle
  gepairten Unattended-Geräte.

## [0.4.1] — 2026-05-17

### Behoben

- **Sharer-Steuerung-Lockup nach Trennen.** Eine evtl. noch gehaltene
  Maustaste blieb beim Browser-Disconnect „gedrückt"; das eigene Klicken
  war danach unbrauchbar bis der Sharer-Prozess komplett beendet wurde.
  Automatisches Release-on-Drop in der Input-Pipeline (#97).

## [0.4.0] — 2026-05-14

### Hinzugefügt

- **Unattended Access** — Geräte einmal pairen, dann ohne Code aus dem
  Dashboard verbinden. Auto-Accept oder Geräte-Passwort konfigurierbar
  pro Gerät.
- **Wayland-native Capture** — Plasma 6 und GNOME 47+ funktionieren
  nativ via GStreamer/PipeWire, kein XWayland-Fallback mehr.
- **Feedback-Dialog in der App** — direkt aus dem Sharer (im Unattended-
  Modus) oder dem Dashboard Bugs und Wünsche einreichen.
- **Konto + Dashboard** — Geräteliste, Connection-Log, Auto-Accept-
  Toggle, Geräte-Pairing über
  [auffi.app/dashboard/](https://auffi.app/dashboard/).

### Sicherheit

- **Härtungen** — argon2id für Passwörter, `__Host-`-Session-Cookies,
  Per-Account-Lockout, HMAC-ephemerale TURN-Credentials. Vollständiger
  Audit: [docs/security-review-2026-05.md](docs/security-review-2026-05.md).

[0.4.5]: https://github.com/phash/auffi/releases/tag/v0.4.5
[0.4.4]: https://github.com/phash/auffi/releases/tag/v0.4.4
[0.4.3]: https://github.com/phash/auffi/releases/tag/v0.4.3
[0.4.2]: https://github.com/phash/auffi/releases/tag/v0.4.2
[0.4.1]: https://github.com/phash/auffi/releases/tag/v0.4.1
[0.4.0]: https://github.com/phash/auffi/releases/tag/v0.4.0
