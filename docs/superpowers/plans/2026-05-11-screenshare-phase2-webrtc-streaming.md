# Screenshare Phase 2 — WebRTC + Screen-Streaming (Outline)

> **Status:** Outline only. Wird detailliert ausgearbeitet, sobald Phase 1 läuft und Real-World-Erfahrung mit dem Signaling vorliegt.

**Goal:** Video-Stream vom Sharer-Bildschirm zum Viewer-Browser über WebRTC. Sharer kann unter mehreren Monitoren wählen.

**Voraussetzungen aus Phase 1:** Funktionierendes Signaling-Skelett. `relay`-Messages werden in dieser Phase mit SDP-Offer/Answer und ICE-Candidates befüllt statt mit Hello-World-Payloads.

## Architektur-Änderungen ggü. Phase 1

- **Sharer (Rust):** Integriert `webrtc-rs` Crate als `PeerConnection`. Screen-Capture via `scap` liefert Frames in eine Video-Track-Source. SDP-Verhandlung läuft als `relay`-Nachrichten durch das bestehende Signaling.
- **Viewer (Browser):** Nutzt Browser-nativ `RTCPeerConnection`. Bekommt MediaStream auf `<video>` gerendert.
- **Backend:** Unverändert. Es relayt nur — der Inhalt der `relay`-Messages wird komplexer, das Backend sieht's nicht.
- **STUN:** Public STUN (Google) wird als ICE-Server konfiguriert. Kein TURN in dieser Phase.

## Vorgesehene Tasks

1. **Viewer: `<video>`-Element + WebRTC-PeerConnection-Aufbau.** SDP-Offer erzeugen, über `relay` schicken. Antwort + ICE-Candidates empfangen und anwenden.
2. **Backend: Protocol-Erweiterung dokumentieren.** Neue Relay-Payloads: `{ kind: "sdp", sdp: ... }` und `{ kind: "ice", candidate: ... }`. Backend-Code bleibt unverändert (relay ist agnostic), aber `docs/protocol.md` wird ergänzt.
3. **Sharer: `webrtc-rs` integrieren.** `PeerConnection` aufsetzen. SDP-Offer empfangen, Answer generieren, ICE-Candidates austauschen.
4. **Sharer: Screen-Capture mit `scap`.** Auf primärem Monitor starten. Frames als Video-Track in die `PeerConnection` füttern.
5. **Sharer: Monitor-Auswahl.** Vor Stream-Start zeigt Webview eine Liste verfügbarer Monitore (Tauri-Command + `scap::Display::all()`). Auswahl persistiert für Session-Dauer.
6. **Viewer: UI-Erweiterung.** Statt Status-Text jetzt `<video autoplay muted>`. Verbindungs-Indikator, Trennen-Button.
7. **Sharer: Roter Rahmen + Floating-Panel.** Tauri kann transparente Always-on-Top-Fenster — der rote Rahmen ist ein Always-on-Top, transparenter Frame um den aktiven Monitor. Panel zeigt "Verbunden mit IP …, Trennen".
8. **Adaptive Bitrate (deferred).** Falls Performance schlecht: WebRTC unterstützt RTCP-basierte Anpassung mostly out-of-the-box, sollte erstmal reichen. Nur falls Probleme, manuell drosseln.
9. **End-to-End-Test.** Echte Maus auf Sharer bewegen → Viewer sieht sie. Performance-Sanity: Latenz, FPS, CPU.

## Plattform-Risiken

- **Wayland (Linux):** `scap` nutzt `xdg-desktop-portal`. User-Prompt bei jedem Start. Im Onboarding erklären.
- **Windows:** `scap` nutzt Desktop Duplication API. Sollte unproblematisch sein.
- **macOS:** `scap` nutzt ScreenCaptureKit, ab macOS 12.3 verfügbar. Benötigt User-Permission unter Systemeinstellungen → Datenschutz → Bildschirmaufzeichnung. **Nicht im Test-Scope, best effort.**

## Done When

- Sharer-App teilt Bildschirm, Viewer sieht ihn im Browser bei ~30 fps mit < 300 ms Latenz im LAN.
- Monitor-Auswahl funktioniert auf Linux und Windows.
- Roter Rahmen + Floating-Panel sichtbar während Session.
- Trennen-Button funktioniert von beiden Seiten.
