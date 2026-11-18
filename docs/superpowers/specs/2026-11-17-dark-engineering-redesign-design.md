# Dark-Engineering-Redesign (alle Oberflächen) + Matrix-Icon — Design

- **Datum:** 2026-11-17
- **Status:** Freigegeben 2026-11-18
- **Mockup:** `docs/superpowers/specs/assets/2026-11-17-dark-engineering-mockup.html` (v4, im Browser öffnen; lädt Fonts von Google, nur fürs Mockup)
- **Vorlage:** Dribbble-Shot „Engineering Platform Web Design – ZeBeyond“ (https://dribbble.com/shots/26978736). Die drei Screenshots liegen lokal in `artconcept/` (nicht eingecheckt — fremdes Bildmaterial).

## Ziel und Warum

Der Nutzer ist mit dem heutigen Auftritt („Calm Fresh“, hell, smaragd/mint, IBM Plex) und dem grünen Monitor-Icon nicht zufrieden. Auffi soll aussehen wie eine Engineering-Plattform im Stil von ZeBeyond, das App-Icon mehr nach „Matrix“. Er hat den Mockup v4 freigegeben („ja so ist es gut“) und entschieden:

- **Icon:** Variante A (Phosphor-Monitor).
- **Weg:** Ansatz 2 — alle Oberflächen umstellen **und** eine gemeinsame Token-Datei als einzige Quelle.
- **Umfang:** „alles umstellen“: Marketing-Seiten (DE+EN), Viewer-App, Dashboard, Sharer-Webview, Icons.
- Oben auf der Startseite direkter Einstieg zu **Code-Eingabe und Download**.
- **Spenden-Buttons** (Buy me a coffee + PayPal) an mehreren Stellen.

## Ziele

1. Ein Look auf allen vier Oberflächen: grünschwarzer Grund, feine Linien, leichte Headlines mit mint-farbigen Wortteilen, Türkis→Mint-Verlaufsbutton, Segment-Navigation, Kacheln mit 1-px-Rändern, grüner Schein am Seitenfuß.
2. Eine Token-Datei `design/tokens.css` als Quelle für Farben, Schriften, Radien; keine Oberfläche definiert eigene Farbwerte mehr.
3. Startseite DE+EN: Einstiegskasten „Ich helfe“ (Code-Feld + Verbinden) | „Ich brauche Hilfe“ (Download Windows/Linux, Version, Systeme) direkt unter der Headline.
4. Spenden: Buy me a coffee (`https://buymeacoffee.com/phash`) und PayPal (`https://www.paypal.com/paypalme/mroedig`) in Topbar (nur Kaffee, klein), Footer (beide, alle Website-Seiten inkl. Viewer-App) und als Spendenstreifen auf der Startseite. Sharer: beide Links im „Info“-Tab. Dashboard: keine (Arbeitsoberfläche, kein Footer).
5. Icon A ersetzt Sharer-Icons und Website-Favicons.

## Nicht-Ziele

- Keine Textänderungen an Unterseiten außer den Spenden-Buttons im Footer (SEO-Verträge bleiben).
- Keine Änderung an Verhalten, Flows, Protokoll, Timeouts.
- Keine neue Seite, keine neuen Routen.
- OG-Image (`og-image.png`) bleibt vorerst; eigenes Folge-Ticket.

## Anti-Ziele (wäre ein Fehlschlag, selbst wenn es „funktioniert“)

- Kontrast unter WCAG AA für Fließtext oder Buttons (Zielgruppe: nicht-technische Helfer, oft ältere Menschen).
- Der Connect-Flow wird schwerer: Code-Feld oder Verbinden-Button weniger prominent als heute, oder der Helfer findet den Download nicht.
- Inline-`<style>` oder Fremd-CDN auf prod (CSP `style-src 'self'` verwirft es still).
- Website und App sehen danach wie zwei Produkte aus.
- Startseite reißt die Hub/Spoke-Wortgrenze in `viewer/tests/marketing-seo.test.ts`.

## Rahmenbedingungen

- **CSP:** `style-src 'self'`, keine Inline-Styles auf statischen Seiten; JSON-LD-Änderungen → `npm run csp:sync` + Cluster-Caddyfile von Hand.
- **Self-hosting:** Schriften als woff2 in `viewer/public/fonts/`, `dashboard/public/fonts/`, `sharer/public/fonts/` (je eigenes Asset-Set, s. CLAUDE.md). Neue Schrift **Manrope** (SIL OFL 1.1, AGPL-kompatibel), Schnitte 300/400/500/600, Latin-Subset. Mono bleibt **IBM Plex Mono** (Code-Feld, Code-Anzeige) — bereits vorhanden.
- **Marketing-SEO-Guard:** Hub ≤ 1,3× Wörter der dünnsten Spoke. Einstiegskasten + Spendenstreifen müssen in diesem Budget bleiben; wenn nicht, Hub-Text an anderer Stelle kürzen, nicht den Guard lockern.
- **Help-Content-Sync-Guard** (`tests/help-content-sync.test.ts`) bleibt unberührt.
- **Tests sind DOM-basiert** (Viewer 955, Dashboard 321, Sharer-JS 178): IDs, Klassen, die Tests abfragen, bleiben erhalten. Neue Klassen nur additiv. **Ausnahme:** `viewer/tests/design-tokens.test.ts` prüft die alte Palette und den Dark-Block; er wird neu geschrieben und prüft danach die Tokens in `design/tokens.css` und die Kontrastpaare aus der Abnahme (`--fg`/`--muted`/`--accent-text` auf `--bg` und `--panel` in beiden Modi, `--on-accent` auf `--teal` und `--mint`).
- **Visual-Audit** (`viewer/tests/e2e/visual-audit.spec.ts`, gegen prod) ist das Abnahme-Werkzeug nach dem Deploy.

## Ansätze (betrachtet)

1. **Tokens je Datei tauschen + Startseite umbauen.** Wenig Risiko, aber jede Oberfläche behält ihre eigene Kopie der Werte — nächstes Redesign läuft wieder auseinander.
2. **Wie 1, plus gemeinsame Token-Datei** — *gewählt vom Nutzer.* Eine Quelle, Oberflächen beziehen sie zur Build-Zeit.
3. **Alle 32 Seiten komplett neu nach Mockup.** Einheitlichster Look, höchstes Risiko (SEO-Verträge, Tests), deutlich mehr Arbeit. Verworfen.

## Design

### 1. Token-Quelle `design/tokens.css`

Neue Datei im Repo-Root. Enthält nur Custom-Properties auf `:root` (keine Komponenten-Selektoren). **Hell und dunkel**, wie heute nach Systemeinstellung (kein Umschalter auf der Seite, den gibt es heute auch nicht). **Dunkel ist der Grundzustand** auf bare `:root` (`color-scheme: dark`); der helle Satz überschreibt nur Tokens in `@media (prefers-color-scheme: light) { :root { … color-scheme: light } }`.

| Token | Dunkel | Hell | Rolle |
|---|---|---|---|
| `--bg` | `#0e1311` | `#f3f6f4` | Seitengrund |
| `--panel` | `#151b18` | `#ffffff` | Kacheln, Karten, Eingaben |
| `--panel-2` | `#1a211e` | `#eaf0ec` | Hover, Sekundär-Buttons, Chips |
| `--line` | `#262f2b` | `#d6e0db` | 1-px-Ränder |
| `--line-soft` | `#1d2522` | `#e4ebe7` | Hintergrund-Raster |
| `--fg` | `#eef3f1` | `#0f1a15` | Text |
| `--muted` | `#95a39d` | `#52615a` | Sekundärtext |
| `--accent-text` | `#3ee6a8` | `#087a54` | Hervorgehobene Wortteile, Links |
| `--teal` | `#22d3c5` | `#22d3c5` | Verlaufsstart (Button) |
| `--mint` | `#3ee6a8` | `#3ee6a8` | Verlaufsende (Button), Icon-Akzente |
| `--on-accent` | `#04211a` | `#04211a` | Text auf Verlaufsbutton |
| `--glow` | `rgba(16,150,100,.55)` | `rgba(16,185,129,.18)` | Schein am Seitenfuß |
| `--error` | `#ff7a7a` | `#b42318` | Fehler |
| `--warn` | `#f5c451` | `#8a5a00` | Warnung |
| `--font-sans` | `"Manrope", "Segoe UI", system-ui, sans-serif` | | |
| `--font-mono` | `"Plex Mono", ui-monospace, Consolas, monospace` | | |
| `--radius` | `10px` | | Kacheln |
| `--radius-sm` | `7px` | | Buttons, Chips |
| `--grad-accent` | `linear-gradient(90deg, var(--teal), var(--mint))` | | Primärbutton (in beiden Modi gleich, dunkler Text darauf) |

Hervorhebungen im Text nutzen `--accent-text` (im hellen Modus dunkleres Grün, damit ≥ 4,5:1 auf `--bg`), nie `--mint` direkt.

Die heutigen Token-Namen (`--paper`, `--surface`, `--ink`, `--brand`, `--brand-strong`, `--cyan`, `--edge`, `--signal-on`, `--shadow-*` …) werden in jeder Oberfläche **als Aliase auf die neuen Tokens** gemappt, damit bestehende Regeln sofort umschalten; danach werden die Komponenten auf die neuen Namen gezogen und die Aliase entfernt, wo nichts mehr sie nutzt (keine toten Tokens am Ende).

**Bezug zur Build-Zeit:**
- **Viewer-App, Dashboard, Sharer** (Vite): `@import "../../design/tokens.css";` am Anfang der jeweiligen Haupt-CSS; Vite inlined es in das Bundle.
- **Statische Seiten** (`viewer/public/**`, nicht von Vite verarbeitet): Kopie `viewer/public/tokens.css`, per `<link rel="stylesheet" href="/tokens.css">` vor `topbar-footer.css` eingebunden. Kopie wird von einem Skript `npm run tokens:sync` (viewer) geschrieben; ein Guard-Test (`viewer/tests/tokens-sync.test.ts`) schlägt fehl, wenn `viewer/public/tokens.css` von `design/tokens.css` abweicht (Muster wie `csp:check`).
- Die heutigen `prefers-color-scheme`-Blöcke in den Oberflächen (33) entfallen; der Modus-Wechsel steht nur noch in `tokens.css`. Die zwei `theme-color`-Metas je Seite bekommen `#0e1311` (dunkel) und `#f3f6f4` (hell).

### 2. Komponenten (alle Oberflächen)

- **Typo:** Headlines Manrope 300, `letter-spacing: -0.02em`, `text-wrap: balance`; hervorgehobene Wortteile per `<span class="hl">` in `--accent-text`. Fließtext Manrope 400/16 px. Eyebrows 12 px, uppercase, `letter-spacing: .12em`, `--muted`, optional mit Linien-Icon.
- **Buttons:** Primär = `--grad-accent`, Text `--on-accent`, Radius `--radius-sm`. Sekundär = `--panel-2` + 1-px `--line`. Fokus: 2-px-Outline `--fg`, Offset 2 px.
- **Navigation (Topbar):** Logo links (Icon A + „Auffi“). Die Segment-Leiste in der Mitte enthält **die bestehenden** Topbar-Funktionen, keine neuen Links: „Verbinden“ · „Sharer herunterladen“ · „?“ (Hilfe). Rechts: EN/DE, Einloggen, Konto anlegen, kleiner Kaffee-Button. Damit bleibt der Link-Graph (`CROSS_LINKS` in `marketing-seo.test.ts`) unverändert; das Markup der Topbar ändert sich auf allen Seiten nur um den Kaffee-Button. Mobil wie heute eingeklappt. *(Entscheidung nach Builder-Check: die Mockup-Links „So geht’s / Sicherheit / Vergleich“ waren Platzhalter.)*
- **Kacheln/Karten:** `--panel`, 1-px `--line`, Radius `--radius`, keine Schatten; Raster-Gruppen teilen Ränder (Bento wie im Mockup).
- **Chips:** 10 px uppercase, `--panel-2`; Akzent-Chip mit mint-Tönung.
- **Seitengrund:** `--bg` + 160-px-Linienraster in `--line-soft` + radialer grüner Schein am Fuß (`rgba(16,150,100,.55)`), als CSS-Hintergrund, kein Bild.
- **Formfelder:** `--panel`, Rand `--line`, Fokus-Rand `--mint`. Code-Feld in `--font-mono`, 22 px, `letter-spacing: .1em`.
- **Footer (alle Seiten):** links © / Impressum / Datenschutz / GitHub, rechts zwei Spenden-Buttons.

### 3. Startseite (DE `viewer/index.html`, EN `viewer/en/index.html`)

Reihenfolge wie Mockup v4:
1. Hero zentriert: Eyebrow „Bildschirm-Freigabe · Open Source“, H1 (bestehender Text, Wortteile hervorgehoben), Lead (bestehender Text).
2. **Einstiegskasten** zweispaltig (mobil gestapelt): links „Ich helfe“ = das **bestehende** Code-Formular der App (gleiche IDs, gleiche Logik, nur in den Kasten verschoben); rechts „Ich brauche Hilfe“ = Download Windows (Primär) + Linux (Sekundär, verlinkt `/download/#linux`), Version und Systeme. Ersetzt den heutigen „oder / Jemand anderen um Hilfe bitten?“-Block.
3. Ablaufdiagramm (Inline-SVG, statisch, mit `role="img"` + `aria-label`).
4. „Warum Auffi“-Bento (ersetzt die heutige Trust-Sektion optisch; Inhalte daraus).
5. Spendenstreifen „Auffi ist kostenlos und werbefrei“ + beide Buttons.
6. Bestehende Sektionen (Aktuelles, Download, FAQ) im neuen Stil.

Während einer laufenden Sitzung (App-Zustand `#app.compact`, Stream sichtbar) bleibt das heutige Verhalten: Hero und Marketing-Teile treten zurück, der Stream hat Vorrang.

Neue Kennzahlen nur mit belegten Werten: 60 fps (gemessen 0.7.6, Linux/X11), DTLS-SRTP, 10 Minuten Code-TTL, 9 Ziffern, AGPL. Die im Mockup erfundene „<10 Sekunden“-Kachel entfällt.

### 4. Viewer-App-Zustände

Verbinden-Flow, Status-Zeilen, Stream-Ansicht mit Overlays (Direkt/Relay-Badge, Steuerung, Datei senden, Beenden), Session-Summary, Hilfe-Modal, Feedback-FAB, Matomo-Consent-Banner: alle auf die neuen Tokens. Der Stream-Bereich bekommt `--bg`-Rahmen statt weißer Karte.

### 5. Dashboard

Login/Signup/Verify, Geräte-Liste, Pairing, Admin-Bereich: Tokens + Komponenten wie oben. Bestehende Muster in `docs/frontend-patterns.md` werden auf den neuen Stil umgeschrieben (Abschnitt „Calm Fresh“ → „Dark Engineering“).

### 6. Sharer-Webview

`sharer/index.html` + `sharer/src`: Tokens per Import, Komponenten wie oben. Bestätigungsdialog („Verbinden zulassen“ / „Ablehnen“) muss weiter klar unterscheidbar sein: „Verbinden zulassen“ = Primär-Verlauf, „Ablehnen“ = Sekundär mit `--line`-Rand. Fenstergröße unverändert.

### 7. Icon A

- Quelle: `sharer/src-tauri/icons/app-icon.svg` wird durch Variante A aus dem Mockup ersetzt, aber **ohne** `<text>`-Elemente (Font-abhängig): die Hex-Zeichen werden als Pfade/Rechtecke gezeichnet, damit Rasterung überall gleich ist.
- Daraus generiert (`npx tauri icon sharer/src-tauri/icons/app-icon.svg`): `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`.
- Website: `viewer/public/favicon-32x32.png`, `favicon-128x128.png`, `apple-touch-icon.png` (randlos, ohne abgerundete Ecken, wie heute), `site.webmanifest`-Farben (`theme_color`/`background_color` = `#0e1311`); Dashboard-Favicons gleich.
- Tray-Icon des Sharers nutzt dasselbe Icon (prüfen, ob separat gesetzt).

### 8. Doku

- `docs/frontend-patterns.md`: Design-System-Abschnitt neu.
- `CLAUDE.md`: „Calm Fresh“-Verweise → „Dark Engineering“; `npm run tokens:sync` in Quick Commands.
- Memory `project_calm_fresh_design_system.md` wird ersetzt.

## Entscheidungen, die ich getroffen habe (vom Nutzer korrigierbar)

- **Hell und dunkel nach Systemeinstellung** (vom Nutzer entschieden); dunkel ist der Grundzustand, ohne Umschalter.
- **Manrope** als Sans (nah an der ZeBeyond-Schrift, frei lizenziert); Plex Mono bleibt für Codes.
- Spendenstreifen nur auf der Startseite; Footer-Buttons auf allen Seiten; Kaffee-Button in der Topbar.
- Spendentext: „Server, Relay und Domain zahlt ein einzelner Entwickler. Wenn Auffi dir geholfen hat, freut sich das Projekt über einen Kaffee.“ (vom Nutzer bestätigt), EN entsprechend.
- Unterseiten erben nur Tokens/Komponenten/Footer, kein Layout-Umbau.

## Dem Umsetzer überlassen

- Exakte Abstände, Breakpoints, Icon-Strichstärken innerhalb des Mockups.
- Reihenfolge der Commits (sinnvoll: Tokens+Sync → Viewer-statisch → Viewer-App → Dashboard → Sharer → Icons → Doku).
- Wie die Alias-Phase im Code abläuft, solange am Ende keine toten Tokens bleiben.

## Abnahme

- Alle Test-Suiten grün auf testbox (Baseline: backend 605, viewer 955, dashboard 321, sharer-js 178, sharer-lib 410), plus neuer Tokens-Sync-Guard.
- `npm run csp:check` grün; Cluster-Caddyfile nach Deploy synchron.
- Visual-Audit gegen prod: alle Seiten × Desktop/Mobil durchgesehen, keine weißen Inseln, keine unlesbaren Kontraste.
- Kontrast in **beiden** Modi ≥ 4,5:1: `--fg`, `--muted`, `--accent-text` auf `--bg` und `--panel`; `--on-accent` auf `--teal` und `--mint`.
- Visual-Audit läuft bereits in light + dark; beide Modi werden durchgesehen.
- Echter Connect über prod (Windows-Sharer im Emulator) mit dem neuen Sharer-UI, Screenshot beider Seiten.
- Sharer-Release (Icons + Webview) als 0.8.0, da sichtbarer Auftritt neu.

## Auslieferung (ein Release-Zug)

Website-Deploy und Sharer 0.8.0 gehen **zusammen** raus, damit nie eine dunkle Website neben dem alten grünen Sharer steht: alle Arbeit auf einem Branch, Tag v0.8.0 → CI baut Sharer → Distro- und Windows-Smoke → danach `deploy.sh` mit Website + `KNOWN_ASSETS` 0.8.0 im selben Schritt.
