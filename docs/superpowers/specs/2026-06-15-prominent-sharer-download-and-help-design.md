# Viewer: Prominenter Sharer-Download + „?"-Hilfe — Design

- **Datum:** 2026-06-15
- **Status:** Approved (Brainstorming-Mockups, alle drei Entscheidungen + Scope bestätigt)
- **Branch:** `feat/prominent-sharer-download-help`

## Ziel

Dient Product-Goal #1 (*Einfache Steuerung*): den **Sharer-Download prominenter** machen und die **On-Page-Hilfe verbessern**. Nicht-technische Nutzer sollen auf einen Blick verstehen, welche der zwei Rollen sie haben (helfen ↔ Hilfe bekommen) und wie die App funktioniert.

## Bestätigte Design-Entscheidungen

1. **Topbar = Variante A** — zentrale Gruppe mit zwei gleichwertigen Pillen: „● Verbinden" + „⤓ Sharer herunterladen". Auf **allen ~12 Seiten** (Konsistenz).
2. **Hero-Sekundär-CTA = „button"-Treatment** — unter dem großen Verbinden-Button ein „oder"-Trenner + Zeile „Jemand anderen um Hilfe bitten?" + Outline-Download-Button. **Nur** auf der Haupt-App (Hero existiert nur dort).
3. **Hilfe = „?"-Trigger in der Topbar → zentriertes Focus-Trap-Modal** „Hilfe — So funktioniert Auffi" mit 5 aufklappbaren Abschnitten. Auf **allen Seiten** (App: Vite-Modul; statische Seiten: standalone Vanilla-JS-Overlay).

## Betroffene Dateien

### Topbar-Markup (Variante A) — dupliziert, alle anpassen
- `viewer/index.html` (App)
- `viewer/public/404.html`
- `viewer/public/download/index.html`
- `viewer/public/impressum/index.html`
- `viewer/public/datenschutz/index.html`
- `viewer/public/vergleich/index.html`, `vergleich/teamviewer/index.html`, `vergleich/anydesk/index.html`
- `viewer/public/en/download/index.html`, `en/compare/index.html`, `en/compare/teamviewer/index.html`, `en/compare/anydesk/index.html`

> EN-Seiten bekommen englische Labels: „Connect" / „Download sharer" / „Help". Sharer-Link auf EN-Seiten → `/en/download/`.

### CSS
- `viewer/src/styles.css` — App-Topbar-Restructure + Hero-CTA + Modal-Styles.
- `viewer/public/topbar-footer.css` — Topbar-Restructure für statische Seiten + Vanilla-Hilfe-Overlay-Styles.

### Hilfe-Element
- **App-Modal:** Modal-Markup (hidden) in `viewer/index.html` + neues `viewer/src/help-modal.ts` (open/close, `trapFocus` aus `focus-trap.ts` wiederverwenden, Escape, Backdrop-Click, Focus-Restore), verdrahtet in `viewer/src/ui.ts` / `main.ts`. Inhalt via nativen `<details>/<summary>` (a11y, kein Expand-JS nötig).
- **Statische Seiten:** neues `viewer/public/help-overlay.js` + `viewer/public/help-overlay.css` (standalone Vanilla, baut + öffnet dasselbe Modal, eingebunden per `<script>` wie `feedback-fab.js`). Sprache (DE/EN) anhand `<html lang>`.

## Komponenten-Spezifikation

### 1. Topbar (3-Zonen-Layout)
`links` Wordmark + Tagline · `Mitte` `.topbar-center` (Verbinden-Pille + Sharer-Pille) · `rechts` `.topbar-actions` (?, EN, Einloggen, Konto anlegen, Coffee).

- **Verbinden-Pille:** App → behält das `#notch-connect`-Verhalten (`focusCodeInput`, `href="#code"`, JS-Handler). Statische Seiten → `<a href="/#code">`. Solid emerald.
- **Sharer-Pille (`#topbar-sharer`):** `<a href="/download/">` (EN: `/en/download/`), Outline-Stil mit Download-Icon, `aria-label="Sharer herunterladen"`.
- Altes `#topbar-download` (rechte Gruppe) **entfällt** — Funktion wandert in die prominente Center-Pille.
- Alte fixed `.topbar-notch` **unter** der Leiste entfällt (Markup + CSS); Behavior zieht in die Center-Pille.
- **Responsive:** Tagline `<580px` aus (bestehend). `<720px` Labels in der rechten Gruppe → Icon-only (bestehend). Center-Gruppe darf umbrechen; auf sehr schmal behält „Verbinden" Text, „Sharer" wird icon-only. Touch-Target ≥ 32px.
- **a11y:** echte `<a>/<button>`, `aria-label`, sichtbarer Focus-Ring (bestehende Tokens).

### 2. Hero-Sekundär-CTA (nur App)
Direkt nach `.input-group` (unter `.connect-row`): `.hero-alt-cta` mit „oder"-Divider, Text „Jemand anderen um Hilfe bitten?", Outline-Button „⤓ Sharer herunterladen" → `/download/` (`#hero-sharer-cta`). Nur im Idle sichtbar; bei `body.streaming` ausgeblendet (wie `.eyebrow` / `.hero-title`).

### 3. Hilfe-Modal
- **Trigger** `#help-trigger` („?") in `.topbar-actions`, `aria-haspopup="dialog"`, `aria-label="Hilfe"`.
- **Modal** `#help-modal` `role="dialog"` `aria-modal="true"` `aria-labelledby`, Backdrop-Scrim, Schließen-Button (✕, `aria-label="Schließen"`), Escape + Backdrop-Klick schließen, Focus-Trap, Focus-Restore.
- **Inhalt — 5 `<details>`-Abschnitte (erster offen):**
  1. **Ich möchte jemandem helfen** — Code eingeben → Verbinden → Bildschirm live sehen & (mit Erlaubnis) steuern. Kein Konto, keine Installation.
  2. **Ich brauche selbst Hilfe** — Sharer herunterladen → starten → Code weitergeben → Freigabe bestätigen.
  3. **Was ist der 9-stellige Code?** — einmalig, vom Sharer erzeugt, max. 10 Min gültig, Rateraten per-IP-Rate-Limit gebremst (kein „nach 5 Fehlversuchen verbrannt" — diese Maschinerie feuerte nie, gh PR #114).
  4. **Ist das sicher?** — Ende-zu-Ende DTLS-SRTP-verschlüsselt, Server in Deutschland, Freigabe-Bestätigung Pflicht, keine Tracker.
  5. **Brauche ich ein Konto?** — Nein für spontane Hilfe; Konto nur für unbeaufsichtigten Dauerzugriff.
- EN-Varianten der Texte für die `en/`-Seiten.

## Tests (TDD)
- `viewer/tests/help-modal.test.ts` (neu): open → `hidden=false` + Focus rein; Escape schließt; Backdrop-Klick schließt; Focus-Restore; erster `<details>` default-open.
- `notch-connect`-Tests bleiben grün (Handler bindet an verschobenes Element per id/Klasse; Selektor ggf. anpassen).
- DOM-Presence-Tests: Topbar enthält Verbinden- + Sharer-Link mit korrekten `href`; Hero-CTA-Link → `/download/`.
- `viewer/tests/e2e/visual-audit.spec.ts`: `.topbar-notch`-Selektor → neues zentrales Verbinden-Element; Help-Modal-Screenshot-Flow ergänzen. Visual-Audit (24+ Screenshots) nach Umsetzung sichten.
- Coverage ≥ 70 % für `help-modal.ts`.

## Out of Scope
- GH-Issues, Code-Review-Findings, Lib-Updates — separate Folge-Phasen dieser Session.
- Refactoring der duplizierten Topbar in ein gemeinsames Template (nicht angefragt; wäre eigene Aufgabe).
- Änderungen am Connect-/WebRTC-Kern.

## Definition of Done
`npm test` (viewer) grün · `tsc --noEmit` · Visual-Audit gesichtet · manueller Smoke-Test · atomare Conventional-Commits · Deploy via `ops/deploy.sh`.
