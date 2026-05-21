# Changelog

Alle nennenswerten Änderungen an Auffi werden in dieser Datei dokumentiert.

Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) und das
Projekt nutzt [Semantic Versioning](https://semver.org/lang/de/).

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
