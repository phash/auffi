# Auffi — Konzept (MVP, ursprünglich als "Screenie" spezifiziert)

**Datum:** 2026-05-11
**Status:** Umgesetzt; 2026-05-12 rebrand von Screenie → Auffi (siehe `docs/superpowers/plans/2026-05-12-auffi-rebrand.md`). Dieses Spec-Dokument enthält den ursprünglichen Produktnamen "Screenie" und alle daraus abgeleiteten Identifier — historisch korrekt, nicht aktualisieren.
**Autor:** Manuel + Claude (Brainstorming-Session)

---

## 1. Ziel & Scope

Ein einfaches, sicheres Screen-Sharing-Tool im Stil von TeamViewer für **Ad-hoc-Hilfeszenarien**:
ein Nutzer teilt seinen Bildschirm, ein Helfer kann sich verbinden, sieht den Stream und kann
**Maus & Tastatur fernsteuern**. Verbindungsaufbau läuft über einen kurzen Code, der mündlich
oder per Chat geteilt wird.

**Pflicht-Features (MVP):**
- Bildschirm-Streaming (Sharer → Viewer)
- Remote-Maus & -Tastatur (Viewer → Sharer)
- Mehrere Monitore auswählbar
- Dateitransfer (bidirektional)

**Explizit Out-of-Scope** (siehe §10) — kein Unattended Access, kein Recording, kein Audio,
kein Chat, kein Account-System, kein Mobile-Support.

**Primäre Plattformen:** Linux, Windows. macOS-Code-Pfade bleiben erhalten (Tauri kompiliert),
werden im MVP aber **nicht getestet/garantiert**.

---

## 2. Architektur-Übersicht

Drei klar getrennte Komponenten + ein Relay-Fallback:

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

**Kernprinzip:** Das Backend sieht **niemals** den Bildschirminhalt oder Input-Events.
Es vermittelt nur initial den Handshake. Bildschirm, Maus/Tastatur und Dateien laufen P2P
(direkt zwischen Sharer und Viewer) oder bei NAT-Problemen über den TURN-Server — in beiden
Fällen Ende-zu-Ende DTLS-verschlüsselt.

---

## 3. Verbindungsablauf (Happy Path)

```
Sharer-App startet                                Viewer (Browser)
       │                                                  │
       │  1. WSS connect → "register sharer"              │
       ├─────────────────────────────────────►            │
       │                          ┌──────────┐            │
       │  2. ← Code "284-915-073" │ Backend  │            │
       │◄─────────────────────────┤          │            │
       │                          └──────────┘            │
       │                                                  │
   [User zeigt Code via Telefon/Chat dem Helfer]          │
       │                                                  │
       │                          3. öffnet screenie.mr-development.de
       │                          4. tippt Code ein       │
       │                          ┌──────────┐            │
       │                          │ Backend  │◄───────────┤
       │                          │ matched  │            │
       │                          └────┬─────┘            │
       │                               │                  │
       │  5. "Verbindungsanfrage (IP: 84.xxx, Land: DE)    │
       │     Bestätigen?"  [Ja]  [Nein]                   │
       │                                                  │
       │  6. WebRTC-Handshake (SDP+ICE via Backend-Relay) │
       │◄────────────────────────────────────────────────►│
       │                                                  │
       │  7. P2P-Verbindung steht (oder TURN-Relay)       │
       │═════════════════════════════════════════════════►│
       │     Video-Stream (RTP/SRTP)                      │
       │◄═════════════════════════════════════════════════│
       │     Input-Events (DataChannel)                   │
       │◄════════════════════════════════════════════════►│
       │     Datei-Transfer (DataChannel, on demand)      │
```

**Spezifika:**
- **Code:** 9 Ziffern in 3er-Gruppen (`284-915-073`). Format optimiert fürs Diktieren am Telefon.
- **Code-TTL:** 10 Minuten ab Generierung, oder bis 5 Fehlversuche (dann wird er verbrannt).
- **Bestätigung pflicht:** Der Code allein reicht nicht. Der Sharer muss aktiv im Dialog "Ja" klicken.
- **Monitor-Auswahl:** Nach "Ja" zeigt die Sharer-App vor Stream-Start eine Monitor-Liste.
- **Verbindungs-Indikator:** Während aktiver Session zeigt die Sharer-App ein Floating-Panel
  ("Verbunden mit: …" + "Trennen"-Button) und einen roten Rahmen rund um den geteilten Bildschirm.

---

## 4. Sicherheitskonzept

### Threat Model

| Bedrohung | Schutz |
|---|---|
| Mithören des Streams (Backend, ISP, TURN-Server) | WebRTC = DTLS-SRTP Ende-zu-Ende. Auch eigener TURN sieht nur verschlüsseltes Paket-Relay. |
| Code-Bruteforce | 9 Ziffern = 10⁹. Rate-Limit pro IP (5 Versuche/Min), 5 Fehlversuche pro Code → Code verfällt. |
| Versehentlich geleakter Code | Sharer muss aktiv bestätigen; Code läuft nach 10 Min ab. |
| Bösartiger Viewer übernimmt PC dauerhaft | Session lebt nur, solange Sharer-App offen ist + sichtbares Trennen-Panel. |
| MITM auf Signaling-Kanal | WSS (TLS). DTLS-Fingerprint im SDP verhindert MITM auf Medienkanal. |
| TURN-Server-Missbrauch (Open-Relay) | Short-Term-Credentials: HMAC-Token vom Backend, gültig 1h, validiert via coturn `use-auth-secret`. |
| Replay nach Session-Ende | One-Time-Codes, kein "remember this viewer". |
| Sharer wird unbemerkt ausgespäht | Roter Rahmen + Floating-Panel während Session, Toast bei Trennen. |

### Datenflüsse (was läuft wo)

| Daten | Wo | Größenordnung |
|---|---|---|
| Code-Registrierung & Matching | Backend (WSS) | ~100 Bytes |
| SDP-Offer/Answer + ICE-Candidates | Backend (WSS) | ~5–10 KB einmalig |
| Keep-Alive, Trennen-Notifications | Backend (WSS) | wenige Bytes/Min |
| TURN-Credential-Abruf | Backend (HTTPS) | ~500 Bytes |
| Viewer-Webseite (statisch) | Backend (HTTPS) | ~50–200 KB, cached |
| **Video-Stream** | **P2P** ⟶ TURN bei NAT-Problem | 1–10 Mbit/s |
| **Input-Events (Maus/Tastatur)** | **P2P** ⟶ TURN bei NAT-Problem | ~1–10 KB/s |
| **Dateitransfer** | **P2P** ⟶ TURN bei NAT-Problem | beliebig |

Backend-Last pro Session: **vernachlässigbar** (~20 KB + leichter WebSocket).
TURN-Last: nur bei P2P-Fehlschlag (geschätzt 20–30 % der Sessions), dann **alles** im Doppel
(rein + raus auf dem Relay).

---

## 5. Monetarisierung & TURN-Limits

**Geschäftsmodell:** Grundnutzung kostenlos, Premium hebt das TURN-Limit auf.

**Free-Tier — Limit pro TURN-Session:**
- **10 Minuten** ODER
- **500 MB** Transferdaten
- Was zuerst eintritt, beendet die Session.

**Was nicht limitiert ist:**
- Backend/Signaling-Traffic
- Erfolgreiche P2P-Sessions (~70–80 % der Fälle laufen ohne TURN) — die merken nichts vom Limit.

**Begründung:**
- P2P klappt für die meisten Heim-Setups (Standard-NAT). Diese User sind „happy & free".
- TURN-Sessions kommen primär aus restriktiven Netzen (Firma, Hotel, VPN). Genau die zahlungswillige Zielgruppe.
- 10 Min reicht für realistische Hilfe-Sessions („zeig mir das"), spürt aber Conversion-Wert bei längerer Nutzung.
- 500 MB ist fair übers Qualitätsspektrum: ~22 Min bei Low Quality, ~7 Min bei High.

**UX bei Limit-Annäherung:**
- Bei Minute 8 / 400 MB: Toast „Noch 2 Min / 100 MB — Premium ab €X/Monat".
- Bei Hard-Cutoff: saubere Trennung, Sharer + Viewer sehen Upgrade-Hinweis (nicht „broken").
- Pro Session, nicht pro Tag — neue Verbindung braucht neuen Code (gewollte Reibung).

**Premium (Out-of-Scope für MVP, Hook ins Datenmodell aber vorsehen):**
- Unlimitiertes TURN, höhere Default-Qualität, später: Multi-Viewer, Recording.
- Abrechnung über bestehende MRD-Plattform (mr-development.de).

---

## 6. Tech-Stack

### Sharer-App (Tauri 2)

**Rust-Core:**
- `scap` — Cross-Platform Screen-Capture (Linux/Wayland & X11, Windows, macOS).
- `enigo` — Input-Injection (Maus, Tastatur) für alle OS.
- `webrtc-rs` — WebRTC-Stack in reinem Rust.
- `tokio-tungstenite` — WebSocket-Client zum Signaling-Backend.

**Webview-UI (HTML/CSS/TS):**
- Statusanzeige, Code-Display, Monitor-Auswahl, Bestätigungsdialog, Floating-Panel mit Trennen-Button.
- Bewusst minimal — keine Framework-Abhängigkeit.

**Bundle-Größe-Ziel:** ~10–15 MB pro Plattform.

### Viewer (Web)

- Vanilla TypeScript + Vite. Keine Framework-Abhängigkeit.
- Browser-native APIs: `RTCPeerConnection`, `<video>`, `PointerEvent`, `KeyboardEvent`.
- Dateitransfer: `RTCDataChannel` mit Chunking (16 KB pro Chunk via `FileReader`).

### Backend (Signaling)

- **Node.js + Fastify + `ws`** (WebSocket-Library).
- **In-Memory-State**: `Map<code, { sharerSocket, viewerSocket?, expiresAt, attempts }>`.
  Kein DB im MVP — falls Prozess restartet, müssen offene Sessions neu connecten (akzeptabel).
- **Endpoints**:
  - `WSS /signal` — Sharer & Viewer connecten beide hier.
  - `POST /turn-credentials` — gibt kurzlebiges HMAC-TURN-Token aus.
  - `GET /healthz` — Cluster-Health.
- **Rate-Limit**: `@fastify/rate-limit` (5 Code-Eingaben/Min/IP).

### TURN/STUN

- **coturn** auf IONOS VPS.
- Ports: 3478 (UDP/TCP), 5349 (TLS).
- Modus: `use-auth-secret`, Secret geteilt mit Backend.
- Subdomain: `turn.screenie.mr-development.de`.
- Quota-Settings: `bps-capacity` (Server-Cap), `user-quota` (per-Session-Cap z.B. 5 Mbit/s),
  `max-bps`. Session-Tracking via coturn-Logs → täglicher Cron meldet Volumen an MRD-API.

### Deployment

- `screenie.mr-development.de` → Nginx → statisches Viewer-Build + Backend-Reverse-Proxy.
- `turn.screenie.mr-development.de` → coturn (eigene Ports).
- Sharer-App-Binaries: Download unter `screenie.mr-development.de/download`.
- Code-Signing für Win/Mac: **nicht im MVP** (Zertifikatskosten). Linux: signiert.
  Win/Mac: selbstsigniert mit Erstöffnen-Warnung-Hinweis im Onboarding.

---

## 7. Modul-Grenzen

Drei Verzeichnisse, jedes mit einer Verantwortung:

```
screenie/
├── sharer/          # Tauri-App  (Rust + minimales TS-UI)
├── viewer/          # Web-App    (TS + Vite)
├── backend/         # Signaling  (Node.js + Fastify)
└── docs/
    └── superpowers/
        └── specs/   # Dieses Dokument
```

Schnittstellen sind klein und versioniert:

- **Signaling-Protokoll** (JSON-Messages über WSS): dokumentiert in `docs/protocol.md`
  (wird mit dem Implementierungsplan erstellt).
- **TURN-Credential-API** (REST mit JSON-Schema): dokumentiert in `docs/protocol.md`.

Damit ist später z.B. ein Austausch des Viewers gegen eine native Variante möglich, ohne
Sharer oder Backend anzufassen.

---

## 8. Testing-Strategie

| Ebene | Was | Tools |
|---|---|---|
| Unit | Rust-Module (Code-Gen, Input-Mapper, Capture-Wrapper); Backend-Logik (TTL, Rate-Limit, Matching) | `cargo test`, `vitest` |
| Integration | Signaling-Backend mit zwei WebSocket-Clients als Sharer+Viewer | `vitest` + In-Memory-Server |
| E2E | Headless-Chromium als Viewer, Sharer-App auf Test-VM. Verifiziert: Video kommt an, Input-Event löst Maus-Move aus. | Playwright + Tauri-Test-Mode |
| Manuell | NAT-Traversal in realen Netzwerken (Heim-WLAN, Mobile-Tethering, Firmen-VPN) | Pre-Release-Checkliste |

Echte WebRTC-E2E ist trickreich (Browser-Permissions, Display-Capture-Prompts).
Pragmatisch: P2P-Logik mit Mocks testen, finale Pipeline manuell verifizieren.

---

## 9. Out-of-Scope (bewusst)

Damit niemand erwartet, das hier mitzubekommen:

- Unattended Access (Helfer verbindet sich auf leeren PC)
- Recording von Sessions
- System-Audio-Übertragung
- Chat-Fenster
- Account-System, Geräte-Liste, Kontakte
- Mobile Viewer (iOS/Android)
- Code-Signing für Win/Mac (MVP: selbstsigniert mit Warnung)
- Clipboard-Sync zwischen Sharer & Viewer
- Mehrere Viewer pro Session
- macOS-Garantie (Code-Pfade vorhanden, ungetestet)

Jeder Punkt machbar, aber bricht „einfach". Liste später bei Bedarf abarbeiten.

---

## 10. Open Questions / Risiken

Nichts blockt den Implementierungsplan. Verbleibende Punkte:

1. **Wayland-Capture auf Linux**: ✅ Implementiert (Phase 5, 2026-05-12).
   Läuft über `xdg-desktop-portal` (ScreenCast-Portal) + PipeWire. Triggert bei
   jedem Start einen User-Prompt ("Choose what to share") — das ist das
   Sicherheitsmodell des Compositors und unumgehbar. Erklärt in `INSTALL-LINUX.md`.
   Backend-Auswahl erfolgt automatisch anhand von `XDG_SESSION_TYPE`.
2. **macOS-Permissions**: Screen Recording + Accessibility müssen vom User in den
   Systemeinstellungen erlaubt werden. Da macOS nicht im Test-Scope ist, dokumentieren wir
   das in einem README, garantieren aber nichts.
3. **TURN-Bandbreite real**: coturn-Quota-Settings müssen nach ersten echten Sessions
   feinjustiert werden. Erstes Monitoring zeigt, ob 5 Mbit/s pro Session passt oder
   nach unten/oben angepasst werden muss.

---

## 11. Erfolgskriterien

- Verbindungsaufbau dauert vom App-Start bis zum Stream **unter 30 Sekunden** (für den
  durchschnittlichen Heim-User).
- Sharer-App-Bundle **unter 20 MB** pro Plattform.
- In 95 % aller Sessions zwischen normalen Privat-Anschlüssen klappt **P2P**, d.h. kein
  TURN-Traffic.
- Latenz Input → Bildschirmreaktion **unter 150 ms** im LAN, **unter 300 ms** über Internet bei P2P.
- Keine bekannten Wege, eine Verbindung ohne Sharer-Bestätigung aufzubauen (manuell geprüft).
