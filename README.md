# Auffi

**Sicheres, einfaches Screen-Sharing mit Fernsteuerung — wie TeamViewer, nur offen.**

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/phash/screenie/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/phash/screenie)

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
- 🔢 9-stelliger Code + aktive Bestätigung — kein Konto, keine Registrierung
- 🛡️ DSGVO-konform — keine IPs im Klartext gespeichert, keine Tracker, kein Logging von Inhalten
- 🌐 STUN + TURN für restriktive Netzwerke (hinter CGNAT, Firewalls)

---

## Quickstart

### Als Helfer (Viewer)

Browser öffnen und zur Referenzinstanz navigieren:

```
https://auffi.app
```

Code eingeben, den der Hilfesuchende mitteilt — fertig.

### Als Hilfesuchender (Sharer)

Auffi-App herunterladen und starten:

```bash
# Schnell-Installation (Linux):
curl -fsSL https://raw.githubusercontent.com/phash/screenie/main/scripts/install-linux.sh | bash
```

Oder manuell aus den [Releases](https://github.com/phash/screenie/releases) herunterladen —
detaillierte Anleitung: [INSTALL-LINUX.md](INSTALL-LINUX.md)

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

Vollständige Anleitung: **[INSTALL-LINUX.md](INSTALL-LINUX.md)**

Schnell-Installation:

```bash
curl -fsSL https://raw.githubusercontent.com/phash/screenie/main/scripts/install-linux.sh | bash
```

Für `.deb`, `.rpm` und AppImage: siehe [Releases](https://github.com/phash/screenie/releases).

---

## Selbst hosten

Deployment-Dokumentation: **[ops/README.md](ops/README.md)**

Die Referenzinstanz `auffi.app` läuft auf einem IONOS VPS via Docker Compose
(Backend + coturn + Caddy als Reverse Proxy). Für eigene Instanzen:

```bash
cp .env.example .env
# .env anpassen (TURN_SECRET, DOMAIN, etc.)
docker compose -f docker-compose.prod.yml up -d
```

---

## Entwicklung

```bash
git clone https://github.com/phash/screenie.git   # auto-redirects to phash/auffi after rename
cd screenie
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

Detaillierte Pläne und Spezifikationen: [`docs/superpowers/`](docs/superpowers/)

---

## Tech-Stack

| Komponente | Technologie |
|---|---|
| Backend | Node.js 22 / Fastify 5 |
| Viewer | Vite + TypeScript (Vanilla) |
| Sharer | Tauri 2 / Rust 1.84+ |
| WebRTC | webrtc-rs (libwebrtc) |
| TURN/STUN | coturn |
| Reverse Proxy | Caddy |
| Deployment | Docker Compose |

---

## Sicherheit & DSGVO

- **Verschlüsselung:** WebRTC-Streams sind DTLS-SRTP-verschlüsselt (P2P oder via TURN)
- **Keine Inhalte im Backend:** Signaling-Server sieht nur SDP/ICE-Handshake, nie Pixel oder Events
- **IPs pseudonymisiert:** Nur das Prefix (`84.xxx`) wird im Bestätigungsdialog angezeigt — niemals die vollständige IP gespeichert
- **Kein Tracking:** Keine Cookies, kein Analytics, kein Account-System
- **Code-TTL:** 9-stellige Codes verfallen nach 10 Minuten oder nach 5 Fehlversuchen
- **Aktive Bestätigung:** Sharer muss jede Verbindung explizit annehmen

Vollständige Spezifikation: [`docs/superpowers/specs/`](docs/superpowers/specs/)

---

## Status

**Fertig (MVP):**
- ✅ WebSocket-Signaling-Backend (Node.js/Fastify, Dockerized)
- ✅ WebRTC Peer-to-Peer Verbindung (Video-Stream + DataChannel)
- ✅ Bildschirm-Sharing (X11, multi-Monitor)
- ✅ Remote-Maus + Tastatur (Viewer steuert Sharer)
- ✅ Bidirektionaler Dateitransfer (Drag-and-Drop)
- ✅ 9-stelliger Code + Bestätigungsdialog
- ✅ TURN-Fallback via coturn
- ✅ Production Deployment auf IONOS VPS
- ✅ Smoke-Tests + manuelle Testprotokolle

**Geplant / In Arbeit:**
- ❌ Wayland-native Bildschirmerfassung (aktuell: XWayland-Fallback)
- ❌ Audio-Streaming
- ❌ macOS + Windows getestet/zertifiziert
- ❌ CI/CD Pipeline (GitHub Actions)
- ❌ Automatisierte End-to-End Tests
- ❌ Windows-Installer / macOS-DMG

Dies ist ein junges Open-Source-Projekt. Feedback und Beiträge sind willkommen.

---

## Lizenz

MIT — siehe [LICENSE](LICENSE)

---

## Mitwirken

Issues und Pull Requests sind herzlich willkommen. Bitte lies [`CLAUDE.md`](CLAUDE.md)
für Code-Konventionen (Clean Code, TDD, ≥70% Coverage, Docker-Standards).

Für größere Features: Issue öffnen und kurz die Idee beschreiben, bevor du Code schreibst.
