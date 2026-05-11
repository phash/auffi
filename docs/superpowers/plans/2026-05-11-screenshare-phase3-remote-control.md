# Screenie Phase 3 — Remote-Control + Dateitransfer (Outline)

> **Status:** Outline only. Wird detailliert, sobald Phase 2 läuft.

**Goal:** Viewer kann Maus & Tastatur des Sharer-Rechners steuern. Bidirektionaler Dateitransfer.

**Voraussetzungen aus Phase 2:** Stabiler Video-Stream über WebRTC zwischen Sharer und Viewer.

## Architektur-Änderungen ggü. Phase 2

- **Neuer WebRTC-DataChannel `input`:** Viewer → Sharer. Trägt Maus- und Tastatur-Events als JSON.
- **Neuer WebRTC-DataChannel `files`:** bidirektional. Trägt Datei-Metadaten (offer) und Chunks.
- **Sharer (Rust):** Integriert `enigo` Crate für Input-Injection. Empfängt Events vom DataChannel, transformiert in OS-spezifische Aufrufe.
- **Viewer (Browser):** Captured `pointerdown`/`pointermove`/`pointerup`/`wheel` auf dem `<video>`-Element und `keydown`/`keyup` global (während Fokus). Sendet als DataChannel-Message.

## Vorgesehene Tasks

### Input-Forwarding

1. **Protocol: Input-Event-Schema.** JSON-Format definieren: `{ kind: "mouse-move", x, y }`, `{ kind: "mouse-button", button, pressed }`, `{ kind: "scroll", dx, dy }`, `{ kind: "key", code, pressed, modifiers }`. Koordinaten relativ zur Bildschirmauflösung (normalisiert 0..1, damit Viewer-Window-Größe egal).
2. **Viewer: Event-Capture.** Pointer-Events auf `<video>` abgreifen, in normalisierte Koords umrechnen, über DataChannel senden. Auch Modifier-Tasten (Shift, Ctrl, Alt, Meta) korrekt mitsenden.
3. **Viewer: Keyboard-Capture-Toggle.** Bewusster "Remote-Control aktiv"-Modus (Toggle-Button). Während aktiv: alle Keys → Sharer; während inaktiv: lokales Browser-Verhalten. Sicherheits-/UX-Maßnahme gegen ungewollte Tastenanschläge.
4. **Sharer (Rust): `enigo`-Integration.** Input-Events parsen, in `enigo`-Calls umsetzen. Koords entnormalisieren (gegen die geteilten Monitor-Dimensionen).
5. **Sharer: Sicherheits-Pause.** Sharer kann jederzeit per Hotkey (z.B. Ctrl+Alt+Pause) die Remote-Control deaktivieren, ohne die Session zu beenden. Video läuft weiter, aber Input wird verworfen.
6. **Test: Latenz-Messung.** End-to-End Maus → Reaktion auf Sharer. Akzeptabel: < 150 ms LAN, < 300 ms WAN.

### Dateitransfer

7. **Protocol: File-Transfer-Schema.** `{ kind: "file-offer", id, name, size, mime }`, `{ kind: "file-accept", id }` / `{ kind: "file-reject", id }`, `{ kind: "file-chunk", id, seq, data: base64 }`, `{ kind: "file-done", id }`.
8. **Viewer: Datei-Upload via Drag&Drop.** Zone neben/über dem `<video>`. Auf Drop: `file-offer` schicken, auf `accept` warten, dann Chunks streamen.
9. **Sharer (Rust): Datei-Empfang.** Auf `file-offer` Tauri-Webview-Dialog zeigen ("Helfer möchte `report.pdf` (2.3 MB) senden — annehmen?"). Bei Akzeptieren: Chunks zusammensetzen, in `~/Downloads/Screenie/` ablegen.
10. **Umgekehrte Richtung: Sharer → Viewer.** Sharer kann Datei via Webview-Picker auswählen und senden. Viewer lädt sie als Browser-Download.
11. **Chunking-Größe + Backpressure.** 16 KB pro Chunk. Bei `bufferedAmount > 1 MB` auf `bufferedamountlow`-Event warten.

## Sicherheits-Überlegungen

- **Hotkey-Pause** ist die wichtigste Sicherheits-Eskalation. Muss vor Session-Start im Onboarding einmal erklärt werden.
- **Modifier-Hotkeys** (z.B. Ctrl+Alt+Del, Win+L) werden vom OS auf der Sharer-Seite gefangen, nicht von der App. Das ist gewollt — Lock-Bildschirm fernsteuern wäre Unattended Access, kein MVP.
- **Datei-Path-Safety:** Empfangene Dateinamen sanitisieren (keine `../`, keine absoluten Pfade). Immer in fixen Ordner schreiben.

## Done When

- Maus-Bewegung und Klick funktioniert auf Linux + Windows, Latenz < 300 ms.
- Tastatureingabe funktioniert (mit Modifier-Tasten).
- Hotkey-Pause stoppt Input ohne Session zu trennen.
- Dateitransfer in beide Richtungen funktioniert, auch bei großen Dateien (> 100 MB).
