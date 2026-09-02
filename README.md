# Auffi

**Sicheres, einfaches Screen-Sharing mit Fernsteuerung — wie TeamViewer, nur offen.**

[![Latest Release](https://img.shields.io/github/v/release/phash/auffi?label=release)](https://github.com/phash/auffi/releases/latest)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/phash/auffi/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/phash/auffi)
[![Changelog](https://img.shields.io/badge/changelog-keep--a--changelog-orange)](CHANGELOG.md)

---

Auffi ermöglicht spontane Bildschirmhilfe: Der Hilfesuchende startet eine kleine Desktop-App,
erhält einen 9-stelligen Code und gibt ihn dem Helfer — der öffnet einfach den Browser. Keine
Accounts, keine Cloud-Daten, keine Tracker. Die eigentliche Verbindung läuft Peer-to-Peer und ist
Ende-zu-Ende DTLS-SRTP-verschlüsselt. Das Backend sieht zu keinem Zeitpunkt Bildschirminhalte,
Mausbewegungen oder Dateien — nur den initialen Handshake.

---

## Features

- 🖥️ Bildschirm teilen via WebRTC (Ende-zu-Ende verschlüsselt, DTLS-SRTP)
- 🖱️ Maus + Tastatur fernsteuern (vom Viewer aus, mit aktiver Genehmigung)
- 📁 Bidirektionaler Dateitransfer (Drag-and-Drop, WebRTC DataChannel)
- 🔢 9-stelliger Code + aktive Bestätigung — anonym, ohne Konto
- 🛡️ DSGVO-konform — keine IPs im Klartext gespeichert, keine Tracker, kein Logging von Inhalten
- 🌐 STUN + TURN für restriktive Netzwerke (hinter CGNAT, Firewalls)
- 🪪 Optionale Account-Modus mit Geräte-Pairing (Unattended Access) — argon2id-Passwörter, geräte-spezifische Tokens, lokales + serverseitiges Lockout

---

## Quickstart

### Als Helfer (Viewer)

Browser öffnen und zur Referenzinstanz navigieren:

```
https://auffi.app
```

Code eingeben, den der Hilfesuchende mitteilt — fertig.

### Als Hilfesuchender (Sharer)

Auffi-App herunterladen und starten — alle Installer gebündelt auf der
Download-Seite: **[auffi.app/download](https://auffi.app/download/)**

- **Windows:** `.msi` oder `.exe` (Setup) — oder das Portable ohne Installation.
- **Linux:** `.deb`, `.rpm`, `.AppImage` — oder die Schnell-Installation:

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash
```

- **macOS:** noch kein Build (kein Capture-Backend — nur Linux + Windows).

Oder manuell aus den [Releases](https://github.com/phash/auffi/releases) —
Paket-Installation Schritt für Schritt: [INSTALL-LINUX.md](INSTALL-LINUX.md);
selbst bauen inkl. Arch-PKGBUILD: [INSTALL.md](INSTALL.md).
Was sich pro Version geändert hat, steht im [CHANGELOG](CHANGELOG.md).

---

## Architektur

```
┌─────────────────┐                       ┌──────────────────┐
│  Sharer (Tauri) │◄────────P2P──────────►│ Viewer (Browser) │
│  Rust + WebView │  WebRTC (DTLS-SRTP)   │ Vanilla TS       │
└────────┬────────┘                       └────────┬─────────┘
         │           Signaling (WSS)               │
         └─────────────┐         ┌─────────────────┘
                       ▼         ▼
                ┌─────────────────────┐
                │  Backend (Node.js)  │   ─┐
                │  - Code-Generator   │    │  Auf IONOS VPS
                │  - WebSocket-Relay  │    │  (MRD-Cluster)
                │  - REST /api/*      │    │
                └──────────┬──────────┘    │
                           ▲               │
                           │ HTTPS         │
                ┌──────────┴──────────┐    │
                │ Dashboard (Browser) │    │  Konto + Geräteliste
                │ Vanilla TS, SPA     │    │  (nur Unattended-Modus)
                └─────────────────────┘    │
                                           │
                ┌─────────────────────┐    │
                │ coturn (TURN/STUN)  │   ─┘
                │ Fallback wenn P2P   │
                │ via NAT scheitert   │
                └─────────────────────┘
```

**Kernprinzip:** Das Backend sieht niemals Bildschirminhalte oder Input-Events.
Es vermittelt nur den initialen Handshake (WebSocket-Signaling). Bildschirm, Maus/Tastatur
und Dateien laufen P2P oder bei NAT-Problemen über den TURN-Server — in beiden Fällen
Ende-zu-Ende DTLS-verschlüsselt.

---

## Installation auf dem Linux-Desktop

Vollständige Anleitung inkl. Arch-PKGBUILD, Debian/Ubuntu `.deb`,
Fedora `.rpm` und distroübergreifender AppImage: **[INSTALL.md](INSTALL.md)**

Schnell-Installation:

```bash
curl -fsSL https://raw.githubusercontent.com/phash/auffi/main/scripts/install-linux.sh | bash
```

Für `.deb`, `.rpm` und AppImage: siehe [Releases](https://github.com/phash/auffi/releases).

---

## Selbst hosten

Deployment-Dokumentation: **[ops/README.md](ops/README.md)**

Die Referenzinstanz `auffi.app` läuft auf einem IONOS VPS via Docker Compose
(Backend + coturn + Caddy als Reverse Proxy). Für eigene Instanzen:

```bash
cp .env.prod.example .env.prod
# .env.prod anpassen: TURN_SHARED_SECRET, TURN_REALM, TURN_HOSTS,
# TURN_LISTENING_IP/TURN_EXTERNAL_IP (Cloud-VPS), ALLOWED_ORIGINS (Pflicht —
# ohne den Wert startet das Backend in production nicht), SMTP_* fürs Konto-Mailing
docker compose -f docker-compose.prod.yml up -d
```

(`.env.example` ist die **Dev**-Datei für `docker compose up` / `npm run dev`;
`docker-compose.prod.yml` liest ausschließlich `.env.prod`.) Schritt-für-Schritt
inkl. Caddy, coturn und Backups: [ops/README.md](ops/README.md) § 2.

---

## Entwicklung

```bash
git clone https://github.com/phash/auffi.git
cd auffi
cp .env.example .env
```

### Backend

```bash
docker compose up backend
```

### Viewer (Browser-App)

```bash
cd viewer
npm ci
npm run dev
# → http://localhost:5173
```

### Sharer (Tauri-Desktop-App)

```bash
cd sharer
npm ci
npm run tauri:dev
```

Voraussetzungen für Tauri: Rust, `webkit2gtk-4.1`, `libvpx`. Auf Arch:

```bash
sudo pacman -S webkit2gtk-4.1 libvpx base-devel
```

### Dashboard (Konto + Geräteliste, nur Unattended-Modus)

```bash
cd dashboard
npm ci
npm run dev
# → http://localhost:5174
```

Detaillierte Pläne und Spezifikationen: [`docs/superpowers/`](docs/superpowers/)

---

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Node.js 22 / Fastify 5 / better-sqlite3 |
| Viewer | Vite 8 + TypeScript (Vanilla) |
| Dashboard | Vite 8 + TypeScript (Vanilla SPA) |
| Sharer | Tauri 2 / Rust 1.84+ |
| WebRTC | webrtc-rs (libwebrtc) |
| Auth | argon2id (m=64 MiB, t=3, p=1), `__Host-` session cookies |
| Wayland-Capture | GStreamer pipewiresrc (Plasma 6 kompatibel) |
| TURN/STUN | coturn |
| Reverse Proxy | Caddy |
| Deployment | Docker Compose |

---

## Sicherheit & DSGVO

- **Verschlüsselung:** WebRTC-Streams sind DTLS-SRTP-verschlüsselt (P2P oder via TURN)
- **Keine Inhalte im Backend:** Signaling-Server sieht nur SDP/ICE-Handshake, nie Pixel oder Events
- **IPs pseudonymisiert:** Nur das Prefix (`84.xxx`) wird im Bestätigungsdialog angezeigt — niemals die vollständige IP gespeichert
- **Kein Tracking:** Keine externen Cookies, kein Analytics, keine Drittanbieter-CDNs
- **Code-TTL:** 9-stellige Codes verfallen nach 10 Minuten; Rateraten ist serverseitig durch ein Per-IP-Rate-Limit gebremst
- **Aktive Bestätigung:** Sharer muss jede Verbindung explizit annehmen
- **Account-Sicherheit (Unattended-Modus):** argon2id für Passwörter, `__Host-`-Cookies (HttpOnly + Secure + SameSite=Strict), Per-IP-Rate-Limit auf WSS-Bearer-Auth (Sec H-1), Per-Account-Lockout (5 Fehlversuche / 15 min, Sec H-3), TLS-pinned Session-Tokens (nur sha256 in DB, Sec C-1)

Vollständige Spezifikation: [`docs/superpowers/specs/`](docs/superpowers/specs/) — Audit: [`docs/security-review-2026-05.md`](docs/security-review-2026-05.md)

---

## Status

**Fertig (MVP):**
- ✅ WebSocket-Signaling-Backend (Node.js/Fastify, Dockerized)
- ✅ WebRTC Peer-to-Peer Verbindung (Video-Stream + DataChannel)
- ✅ Bildschirm-Sharing (X11 + Wayland via GStreamer/pipewiresrc, multi-Monitor)
- ✅ Remote-Maus + Tastatur (Viewer steuert Sharer)
- ✅ Bidirektionaler Dateitransfer (Drag-and-Drop)
- ✅ 9-stelliger Code + Bestätigungsdialog
- ✅ TURN-Fallback via coturn
- ✅ Production Deployment auf IONOS VPS
- ✅ Unattended Access mit Konto + Geräte-Pairing (Dashboard, argon2id, Sessions)
- ✅ Sicherheits-Audit + Postmortems (`docs/security-review-2026-05.md`)
- ✅ Windows-Port: Capture (WGC + GDI-Fallback) + Installer (`.msi` / `.exe` / Portable)
- ✅ CI/CD (GitHub Actions): Linux- + Windows-Builds + automatische Releases auf Tag-Push
- ✅ Playwright-E2E-Suite für den Viewer (Connect / Input / Dateitransfer gegen Mock-Sharer)
- ✅ Backend 441, Sharer 207 (Rust) + 46 (Webview), Dashboard 142, Viewer 350 Tests

**Geplant / In Arbeit:**
- ❌ Audio-Streaming
- ❌ macOS (kein Capture-/Input-Backend — kompiliert nicht)
- ❌ E2E für den Sharer + den Unattended-Roundtrip (Viewer-Ad-hoc ist abgedeckt)

Dies ist ein junges Open-Source-Projekt. Feedback und Beiträge sind willkommen.

---

## Lizenz

AGPL-3.0-only — siehe [LICENSE](LICENSE).

Copyleft mit Netzwerk-Klausel: Wer Auffi forked **und** als gehosteten
Service anbietet, muss seine Modifikationen ebenfalls unter AGPL-3.0
veröffentlichen. Eigennutzung, Selbst-Hosting im LAN und Forks für
private Zwecke sind unbeschränkt erlaubt.

---

## Mitwirken

Issues und Pull Requests sind herzlich willkommen. Bitte lies [`CLAUDE.md`](CLAUDE.md)
für Code-Konventionen (Clean Code, TDD, ≥70% Coverage, Docker-Standards).

Für größere Features: Issue öffnen und kurz die Idee beschreiben, bevor du Code schreibst.
