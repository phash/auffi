# Dark-Engineering-Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle vier Auffi-Oberflächen (statische Website, Viewer-App, Dashboard, Sharer-Webview) auf den „Dark Engineering“-Look aus Mockup v4 umstellen, mit Hell/Dunkel nach Systemeinstellung, einer gemeinsamen Token-Datei, neuer Startseite, Spenden-Buttons und Icon A. Ausgeliefert als Sharer 0.8.0 zusammen mit dem Website-Deploy.

**Architecture:** `design/tokens.css` ist die einzige Quelle für Farben, Schriften und Radien. Die Vite-Oberflächen importieren die Datei zur Build-Zeit. Die statischen Seiten laden eine per `npm run tokens:sync` erzeugte Kopie `viewer/public/tokens.css`, ein Guard-Test prüft die Gleichheit. Jede Oberfläche verliert ihre eigenen Farbwerte und `prefers-color-scheme`-Blöcke. Ein gemeinsamer Guard-Test (`viewer/tests/design-system-guard.test.ts`) nimmt Oberfläche für Oberfläche in seine Liste auf.

**Tech Stack:** Vanilla CSS (Custom Properties, `@import` via Vite/postcss), Vite, TypeScript, Vitest (jsdom), Tauri 2 (`npx tauri icon`), Playwright (Visual-Audit).

**Spec:** `docs/superpowers/specs/2026-11-17-dark-engineering-redesign-design.md`. Mockup: `docs/superpowers/specs/assets/2026-11-17-dark-engineering-mockup.html`. Lies beide vor jedem Task. Der Mockup ist die Referenz für Abstände, Raster, Schein, Segment-Leiste, Einstiegskasten, Bento, Spendenstreifen und Icon A (`<symbol id="i-a">`).

## Global Constraints

- Branch `feat/dark-engineering-redesign`. Conventional Commits, Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests laufen auf testbox via `tb-run`, nie schwere Suiten auf CachyTop. Einzelne Testdatei/Typecheck < 30 s lokal erlaubt. Muster: `rsync -a --delete --exclude node_modules --exclude target --exclude .venv --exclude dist ./ testbox:work/screenshare/` dann `ssh testbox "tb-run 'screenshare:<was> (cachytop)' -- bash -lc 'cd ~/work/screenshare/<pkg> && npm ci && npm test'"`.
- Baseline, die nicht sinken darf: backend 605, viewer 955, dashboard 321, sharer-js 178, sharer-lib 410. Neue Tests kommen dazu. Ersetzte Tests in `design-tokens.test.ts` zählen als ersetzt, nicht als Verlust.
- Statische Seiten: kein inline `<style>`, kein Fremd-CDN (prod CSP `style-src 'self'`). Schriften self-hosted.
- Manrope: SIL OFL 1.1, Schnitte 300/400/500/600, Latin-Subset, woff2, aus `@fontsource/manrope` (exakte aktuelle Version via `npm view @fontsource/manrope version`, nur die Dateien kopieren, keine Dependency). Plex Mono bleibt.
- Tokens exakt wie Spec-Tabelle §1. Hervorhebungen im Text nutzen `--accent-text`, nie `--mint`.
- Spenden-URLs exakt: `https://buymeacoffee.com/phash`, `https://www.paypal.com/paypalme/mroedig`. Externe Links mit `target="_blank" rel="noopener noreferrer"`.
- Spendentext DE exakt: „Server, Relay und Domain zahlt ein einzelner Entwickler. Wenn Auffi dir geholfen hat, freut sich das Projekt über einen Kaffee.“ EN: “One developer pays for the server, relay and domain. If Auffi helped you, the project appreciates a coffee.”
- Bestehende IDs/Klassen, die Tests abfragen, bleiben. Neue Klassen nur additiv. Keine Textänderung an Unterseiten außer Topbar-Kaffee und Footer-Spenden.
- `theme-color`-Metas: dunkel `#0e1311`, hell `#f3f6f4`.
- Kein Dead Code: alte Token-Namen, alte IBM-Plex-Sans-Dateien und ihre Preloads sind am Ende weg.
- Am Ende kein `prefers-color-scheme` außerhalb `design/tokens.css` und seiner Kopie.

## Review Focus

1. **Heller Modus wird vergessen:** Ein Reviewer schaut nur dunkel an. Jede Komponente muss in beiden Modi lesbar sein, besonders Badges/Overlays auf dem Stream, Fehlertext und Chips. Der Guard-Test pinnt Kontraste; der Visual-Audit (Task 10) schaut beide Modi an.
2. **Seite ohne `tokens.css`:** Eine statische Seite, die `/topbar-footer.css` lädt, aber nicht vorher `/tokens.css`, rendert ohne Farben. Guard in Task 3.
3. **Connect-Flow während Sitzung:** Mit `#app.compact` (Stream läuft) darf der neue Einstiegskasten den Stream nicht verdrängen. Test in Task 5.
4. **Fokus sichtbar auf dunklem Grund:** Tastatur-Nutzer brauchen 2-px-Outline `--fg` auf Buttons, Code-Feld, Segment-Leiste, Spenden-Buttons. Guard-Assertion in Task 1 (`:focus-visible`-Regel nutzt `var(--fg)`), Sichtprüfung in Task 10.
5. **Sharer öffnet PayPal nicht:** Der Opener-Scope blockiert unbekannte URLs lautlos (`.catch(() => {})`). Rust-Test in Task 7 pinnt die Allow-Liste.

---

### Task 1: Token-Quelle, Sync-Skript, Guard-Tests

**Files:**
- Create: `design/tokens.css`
- Create: `viewer/scripts/sync-tokens.ts`
- Create: `viewer/public/tokens.css` (generiert)
- Create: `viewer/tests/tokens-sync.test.ts`
- Create: `viewer/tests/design-system-guard.test.ts`
- Rewrite: `viewer/tests/design-tokens.test.ts`
- Modify: `viewer/package.json` (scripts)

**Interfaces:**
- Produces: Custom Properties der Spec-Tabelle §1 auf `:root`; `npm run tokens:sync` / `npm run tokens:check` (Exit 1 bei Abweichung); `SURFACES: string[]` in `design-system-guard.test.ts` (repo-relative CSS-Pfade, die spätere Tasks erweitern).

- [ ] **Step 1: Write the failing tests**

`design-tokens.test.ts` neu: liest `design/tokens.css`. Hilfsfunktionen `luminance`/`contrast` bleiben. `token(name, mode: "dark" | "light")` liest den Wert aus dem bare-`:root`-Block (dunkel) oder aus dem `@media (prefers-color-scheme: light)`-Block (hell; fällt auf dunkel zurück, wenn dort nicht überschrieben).

```ts
it.each(["dark", "light"] as const)("%s: text tokens meet AA on bg and panel", (m) => {
  for (const fg of ["--fg", "--muted", "--accent-text"])
    for (const bg of ["--bg", "--panel"])
      expect(contrast(token(fg, m), token(bg, m))).toBeGreaterThanOrEqual(4.5);
});
it.each(["dark", "light"] as const)("%s: on-accent meets AA on both gradient ends", (m) => {
  expect(contrast(token("--on-accent", m), token("--teal", m))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(token("--on-accent", m), token("--mint", m))).toBeGreaterThanOrEqual(4.5);
});
it("dark is the default and light only overrides inside the media query", () => {
  expect(token("--bg", "dark")).toBe("#0e1311");
  expect(token("--bg", "light")).toBe("#f3f6f4");
  expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*dark/);
});
```

`tokens-sync.test.ts`: `readFileSync("viewer/public/tokens.css")` ist byte-gleich zu `design/tokens.css`, Fehlermeldung nennt `npm run tokens:sync`.

`design-system-guard.test.ts`: `SURFACES = []` (leer, Tasks 3–7 füllen). Pro Datei: (a) kein `prefers-color-scheme`, (b) keine Definition der Legacy-Namen `--paper --surface --ink --ink-soft --ink-on-brand --brand --brand-2 --brand-strong --cyan --cyan-deep --edge --signal-on --signal-off --shadow --shadow-sm --shadow-lift --card-bg --text --text-secondary --accent --accent-hover --accent-active --border --paper-edge --focus --amber --amber-deep --amber-ink --rule --font --success --warning --error-deep --radius-card --radius-input` und keine `var(...)`-Nutzung davon, (c) keine Custom-Property-Definition mit Farbwert (`#hex`, `rgb(`, `hsl(`). Erlaubte lokale Layout-Tokens: `--topbar-height`, `--footer-height`, `--space-*`, `--radius-pill`. Der globale Test „nur `design/tokens.css` und `viewer/public/tokens.css` enthalten `prefers-color-scheme`“ kommt erst in Task 7 dazu, wenn alle Oberflächen umgestellt sind.

- [ ] **Step 2: Run, verify fail**

Run: `cd viewer && npx vitest run tests/design-tokens.test.ts tests/tokens-sync.test.ts`
Expected: FAIL, `design/tokens.css` fehlt.

- [ ] **Step 3: Write `design/tokens.css`**

Exakt Spec-Tabelle §1: bare `:root` mit allen Tokens + `color-scheme: dark`; `@media (prefers-color-scheme: light) { :root { color-scheme: light; … } }` überschreibt nur die Tokens mit abweichendem Hell-Wert. Kopfkommentar: Quelle der Wahrheit, Kopie in `viewer/public/tokens.css` via `npm run tokens:sync`.

- [ ] **Step 4: Write `viewer/scripts/sync-tokens.ts`**

`syncTokens(check: boolean): boolean` — liest `../../design/tokens.css` relativ zur Skriptdatei, vergleicht mit `../public/tokens.css`; ohne `--check` schreibt es die Kopie, mit `--check` Exit 1 bei Abweichung. Muster wie `scripts/sync-csp-hashes.ts`. Scripts: `"tokens:sync": "tsx scripts/sync-tokens.ts"`, `"tokens:check": "tsx scripts/sync-tokens.ts --check"`. Dann `npm run tokens:sync`.

- [ ] **Step 5: Run, verify pass**

Run: `cd viewer && npx vitest run tests/design-tokens.test.ts tests/tokens-sync.test.ts tests/design-system-guard.test.ts && npm run tokens:check`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

`feat(design): shared dark/light token source with sync and contrast guards`

---

### Task 2: Manrope self-hosten, IBM Plex Sans entfernen

**Files:**
- Add: `{viewer,dashboard,sharer}/public/fonts/Manrope-{300,400,500,600}.woff2`
- Delete: `{viewer,dashboard,sharer}/public/fonts/IBMPlexSans-{Regular,SemiBold}.woff2`
- Modify: `@font-face` in `viewer/public/topbar-footer.css`, `viewer/src/styles.css`, `dashboard/src/styles.css`, `sharer/index.html` (Sharer-Block wandert in Task 7 mit)
- Modify: Font-Preloads in allen 35 HTML-Seiten (`viewer/index.html`, `viewer/en/**`, `viewer/public/**/index.html`, `404.html`) und `dashboard/index.html`
- Test: `viewer/tests/fonts.test.ts`

**Interfaces:**
- Produces: `font-family: "Manrope"` mit Gewichten 300/400/500/600; `--font-sans` aus Task 1 greift.

- [ ] **Step 1: Write the failing test** `fonts.test.ts`: für jedes Font-Verzeichnis existieren die vier Manrope-Dateien; kein `IBMPlexSans` in irgendeiner `.css`/`.html` der Oberflächen; jede `url("/fonts/…")` in einem `@font-face` zeigt auf eine existierende Datei im Font-Verzeichnis derselben Oberfläche.
- [ ] **Step 2: Run, verify fail.** `cd viewer && npx vitest run tests/fonts.test.ts` — FAIL (Dateien fehlen).
- [ ] **Step 3: Fonts holen.** `npm pack @fontsource/manrope@<aktuell>` in einen leeren Scratch-Ordner, entpacken, `files/manrope-latin-{300,400,500,600}-normal.woff2` als `Manrope-<w>.woff2` in die drei Verzeichnisse kopieren. Lizenz-Hinweis: OFL-Datei des Pakets als `Manrope-OFL.txt` neben die Fonts.
- [ ] **Step 4: `@font-face` ersetzen** (Plex Sans raus, Manrope 4 Schnitte, `font-display: swap`), Preloads auf `Manrope-400.woff2` umstellen (Seiten per kurzem Node-Skript im Scratchpad ändern, nicht committen), alte Plex-Sans-Dateien löschen.
- [ ] **Step 5: Run, verify pass.** fonts-Test + `marketing-seo.test.ts` grün.
- [ ] **Step 6: Commit** `feat(design): self-host Manrope, drop IBM Plex Sans`

---

### Task 3: Statische Seiten verdrahten (Tokens-Link, Metas, Topbar-Kaffee, Footer-Spenden, Brand-Mark) und statisches CSS umstellen

**Files:**
- Modify: alle 35 Seiten (Liste wie Task 2)
- Create: `viewer/public/brand-mark.svg` (Icon A aus Task 8; bis dahin die Mockup-Variante A ohne `<text>` — Task 8 liefert die finale Datei)
- Modify: `viewer/public/topbar-footer.css`, `feedback-fab.css`, `matomo-consent.css`, `compare.css`, `404.css`, `download/style.css`, `legal/style.css`
- Test: `viewer/tests/static-theme.test.ts`; `design-system-guard.test.ts` (`SURFACES` += diese sieben CSS-Dateien)

**Interfaces:**
- Consumes: Tokens (Task 1), Manrope (Task 2).
- Produces: Klassen `.topbar-coffee` (Topbar), `.footer-donate`, `.donate-btn`, `.donate-btn--bmc`, `.donate-btn--paypal` (Footer und Startseiten-Streifen in Task 5), Seitenhintergrund-Regel auf `body` (Raster + Schein), `.hl`, `.eyebrow`, `.btn-primary` / `.btn-secondary`, `.chip`, `.chip--accent`, `.tile` in `topbar-footer.css` (geteilte Komponenten für statische Seiten und Startseite).

- [ ] **Step 1: Write the failing tests** `static-theme.test.ts`, je Seite:
  - `<link rel="stylesheet" href="/tokens.css">` steht vor `/topbar-footer.css`.
  - genau zwei `theme-color`-Metas: `#0e1311` mit `(prefers-color-scheme: dark)`, `#f3f6f4` mit `(prefers-color-scheme: light)`.
  - Topbar `.topbar-actions` enthält `a.topbar-coffee[href="https://buymeacoffee.com/phash"]` mit `aria-label` (DE „Buy me a coffee — Auffi unterstützen“, EN “Buy me a coffee — support Auffi”).
  - `#site-footer .footer-donate` enthält beide Spenden-Links (exakte URLs, `rel="noopener noreferrer"`); der alte BMC-Link in `.legal-links` ist weg.
  - Linkzahl intern unverändert: `CROSS_LINKS`-Teil von `marketing-seo.test.ts` bleibt grün (nur laufen lassen).
  Plus `SURFACES` um die sieben CSS-Dateien erweitern.
- [ ] **Step 2: Run, verify fail.** `cd viewer && npx vitest run tests/static-theme.test.ts tests/design-system-guard.test.ts`
- [ ] **Step 3: Seiten-Markup per Scratch-Skript ändern** (nicht committen): Tokens-Link, Metas, Kaffee-Button (`☕`-Glyphe + versteckt-lesbares Label, mobil nur Glyphe), Footer-Spenden. Topbar-Wordmark bekommt Icon A über CSS (`.topbar-wordmark::before` mit `background: url("/brand-mark.svg")`), kein Markup-Wechsel.
- [ ] **Step 4: Statisches CSS umstellen.** Alle Farbwerte → neue Tokens, alle `prefers-color-scheme`-Blöcke raus, Legacy-Namen raus. Komponenten laut Spec §2 und Mockup: Segment-Leiste (`.topbar-center` als 1-px-umrandete Gruppe, aktive/Hover-Fläche `--panel-2`), Verlaufsbutton für `.topbar-cta-connect`, Fokus `outline: 2px solid var(--fg); outline-offset: 2px`, Seitenhintergrund (160-px-Raster in `--line-soft`, radialer `--glow` am Fuß, `background-attachment` so, dass der Schein am Dokumentende sitzt), Footer zweigeteilt.
- [ ] **Step 5: Run, verify pass.** Viewer-Suite komplett auf testbox (`tb-run 'screenshare:viewer-t3 (cachytop)'`). Expected: 955 + neue, 0 fail. `npm run csp:check` exit 0.
- [ ] **Step 6: Sichtprüfung lokal** `cd viewer && npm run dev`, `/impressum/`, `/download/`, `/vergleich/` je hell/dunkel per Playwright-Screenshot (`page.emulateMedia({ colorScheme })`) auf testbox; PNGs per Read prüfen.
- [ ] **Step 7: Commit** (zwei Commits): `feat(web): link shared tokens, donation buttons in topbar and footer` und `feat(web): dark engineering styles for static pages`.

---

### Task 4: Viewer-App-Styles (`viewer/src/styles.css`)

**Files:**
- Modify: `viewer/src/styles.css` (`@import "../../design/tokens.css";` als erste Zeile)
- Test: `design-system-guard.test.ts` (`SURFACES` += `viewer/src/styles.css`)

**Interfaces:**
- Consumes: Tokens, Komponenten-Klassen aus Task 3 (die App lädt `topbar-footer.css` ebenfalls).

- [ ] **Step 1: Failing test** — `SURFACES` erweitern. Run: `npx vitest run tests/design-system-guard.test.ts` — FAIL (15 Dark-Blöcke, Legacy-Namen).
- [ ] **Step 2: Umstellen** laut Spec §4: Verbinden-Formular (Code-Feld `--font-mono` 22 px, `letter-spacing: .1em`, Fokus-Rand `--mint`), Status-Zeilen (`--error`/`--warn`), Stream-Bereich mit `--bg`-Rahmen statt weißer Karte, Overlays (Direkt/Relay-Badge als Chip), Session-Summary, Hilfe-Modal, Abbrechen-Button sekundär. Der Stream-Hintergrund darf `#000` bleiben (Video-Letterbox, keine Custom Property).
- [ ] **Step 3: Pass** — Guard grün; ganze Viewer-Suite auf testbox grün; `npm run build` ok (prüft, dass Vite den `@import` außerhalb des Projekt-Roots auflöst).
- [ ] **Step 4: Commit** `feat(viewer): dark engineering styles for the viewer app`

---

### Task 5: Startseite DE + EN

**Files:**
- Modify: `viewer/index.html`, `viewer/en/index.html`, `viewer/src/styles.css` (Startseiten-Abschnitt)
- Modify: `viewer/tests/top-bar.test.ts` (Referenzen auf `.hero-alt-cta`)
- Test: `viewer/tests/landing-entry.test.ts`

**Interfaces:**
- Consumes: `.donate-btn*`, `.tile`, `.chip`, `.hl`, `.eyebrow` (Task 3).
- Produces: `section.entry` mit `.entry-help` (enthält das bestehende Formular mit `#code` unverändert) und `.entry-need` (enthält `#hero-sharer-cta` → `/download/`, Linux-Link → `/download/#linux`, Versionszeile); `figure.flow` (Inline-SVG `role="img"` + `aria-label`); `section.why` (Bento); `section.support` (Spendenstreifen).

- [ ] **Step 1: Failing test** `landing-entry.test.ts`, je DE/EN (jsdom aus der HTML-Datei):
  - `.entry .entry-help` enthält `#code` und den Verbinden-Submit; das Formular ist das erste Formular im Dokument.
  - `.entry .entry-need` enthält `#hero-sharer-cta[href="/download/"]` und `a[href="/download/#linux"]`; Versionstext stimmt mit `softwareVersion` aus dem JSON-LD überein.
  - `.hero-alt-cta` existiert nicht mehr.
  - `figure.flow svg[role="img"][aria-label]` vorhanden.
  - `section.support` enthält den exakten Spendentext und beide Spenden-URLs.
  - Kein Text „<10 Sekunden“ / “<10 seconds”.
  - CSS-Regel: `#app.compact` blendet `.entry-need`, `.flow`, `.why`, `.support` aus (Assertion gegen `styles.css`-Text, wie bestehende CSS-Text-Tests).
  `top-bar.test.ts`: `.hero-alt-cta`-Erwartungen auf `.entry-need` umschreiben (gleiches Verhalten: Sharer-CTA sichtbar, verlinkt `/download/`).
- [ ] **Step 2: Fail verifizieren.**
- [ ] **Step 3: Markup umbauen** nach Spec §3 (Reihenfolge 1–6), bestehende Texte für H1/Lead/Trust/Aktuelles/Download/FAQ wiederverwenden; Trust-Inhalte in den Bento; Kennzahlen nur: 60 fps (Linux/X11, gemessen 0.7.6), DTLS-SRTP, 10 Minuten Code-TTL, 9 Ziffern, AGPL.
- [ ] **Step 4: Pass** — `landing-entry`, `top-bar`, `marketing-seo` (Hub-Wortgrenze!), `help-content-sync` grün. Reißt die Wortgrenze: Hub-Text an anderer Stelle kürzen, Guard nicht anfassen. JSON-LD unverändert lassen; falls doch geändert: `npm run csp:sync` und im Commit erwähnen.
- [ ] **Step 5: Sichtprüfung** Startseite DE/EN × hell/dunkel × Desktop/Mobil (390 px) + ein Zustand mit `#app.compact` per Playwright auf testbox.
- [ ] **Step 6: Commit** `feat(web): landing entry box, flow, bento and donation strip`

---

### Task 6: Dashboard

**Files:**
- Modify: `dashboard/src/styles.css` (`@import "../../design/tokens.css";`), `dashboard/index.html` (theme-color-Metas, Favicon-Link `/favicon-32x32.png`)
- Create: `dashboard/public/brand-mark.svg` (gleiche Datei wie viewer, Task 8 ersetzt beide)
- Test: `design-system-guard.test.ts` (`SURFACES` += `dashboard/src/styles.css`); `dashboard/tests/index-head.test.ts` (Metas + Favicon)

- [ ] **Step 1: Failing tests** (Guard + Head-Test: zwei theme-color-Metas mit den Spec-Werten, `link[rel=icon]` vorhanden).
- [ ] **Step 2: Fail verifizieren.**
- [ ] **Step 3: Umstellen** laut Spec §5: Login/Signup/Verify, Geräte-Liste, Pairing-Code (`--font-mono`), Admin-Bereich (KPI-Kacheln als `.tile`, Filter-Chips, Bar-Chart-Farben `--mint`/`--teal`), Confirm-Modals (destruktiv = `--error`-Rand, nicht Verlauf). Keine Spenden.
- [ ] **Step 4: Pass** — Dashboard-Suite auf testbox (321 + neue), `npm run build`, Guard grün.
- [ ] **Step 5: Commit** `feat(dashboard): dark engineering styles`

---

### Task 7: Sharer-Webview

**Files:**
- Create: `sharer/src/styles.css` (Inhalt des heutigen `<style>` aus `sharer/index.html`, umgestellt; erste Zeile `@import "../../design/tokens.css";`)
- Modify: `sharer/index.html` (`<style>`-Block raus, Inline-`style`-Attribut im Info-Tab raus, PayPal-Button), `sharer/src/main.ts` (`import "./styles.css";`, Click-Handler `#paypal-btn`)
- Modify: `sharer/src-tauri/capabilities/default.json` (+ `{ "url": "https://www.paypal.com/paypalme/mroedig" }`)
- Modify: `sharer/src-tauri/src/lib.rs` Test `webview_may_open_exactly_the_links_it_uses_and_nothing_via_shell` (erwartete Liste + PayPal-URL)
- Test: `sharer/tests/about-donate.test.ts`; `design-system-guard.test.ts` (`SURFACES` += `sharer/src/styles.css`, plus der globale „nur tokens.css hat `prefers-color-scheme`“-Test)

**Interfaces:**
- Produces: `#paypal-btn` (Button, öffnet `https://www.paypal.com/paypalme/mroedig` via `openUrl`), `#bmc-btn` unverändert.

- [ ] **Step 1: Failing tests**
  - Rust: erwartete URL-Liste um `"https://www.paypal.com/paypalme/mroedig"` ergänzen (sortiert).
  - `about-donate.test.ts`: `#panel-about` enthält `#bmc-btn` und `#paypal-btn`; Klick auf `#paypal-btn` ruft `openUrl` mit der exakten URL (Muster wie `update-banner.test.ts`/`main-wiring.test.ts`).
  - Guard: `SURFACES` += `sharer/src/styles.css`; neuer globaler Test „`prefers-color-scheme` nur in `design/tokens.css` und `viewer/public/tokens.css`“ über die in Task 1 genannten Pfade.
- [ ] **Step 2: Fail verifizieren** — `cd sharer/src-tauri && cargo test --lib webview_may_open` (lokal < 30 s, sonst testbox) und `cd sharer && npx vitest run tests/about-donate.test.ts`.
- [ ] **Step 3: Umsetzen.** Styles auslagern und umstellen (Tabs als Segment-Leiste, Karten `.card` = Kachel, Code-Anzeige Plex Mono). Bestätigungsdialog: „Verbinden zulassen“ = `--grad-accent` + `--on-accent`, „Ablehnen“ = `--panel-2` + 1-px `--line`. Info-Tab: Absatz mit Klasse statt Inline-Style, Spendentext DE aus Global Constraints, beide Buttons. Fenstergröße unverändert. Capability ergänzen.
- [ ] **Step 4: Pass** — sharer-js-Suite (178 + neue) und `cargo test --lib` (410) auf testbox, `cargo clippy --lib --tests -- -D warnings`, `cd sharer && npm run build`. Viewer-Guard grün.
- [ ] **Step 5: Sichtprüfung** `npm run dev` im Sharer-Ordner (Vite, Port 5175) im Browser hell/dunkel: Teilen-Tab mit Code, Confirm-Dialog (DOM-Zustand per Konsole), Einstellungen, Info. Echte Tauri-Sicht kommt im Windows-Smoke (Task 10).
- [ ] **Step 6: Commit** `feat(sharer): dark engineering webview and PayPal donation`

---

### Task 8: Icon A

**Files:**
- Replace: `sharer/src-tauri/icons/app-icon.svg` (Mockup `#i-a`, ohne `<text>`: Hex-Glyphen als `<path>`/`<rect>`)
- Regenerate: `sharer/src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico}`
- Replace: `viewer/public/{favicon-32x32.png,favicon-128x128.png,apple-touch-icon.png,brand-mark.svg}`, `dashboard/public/brand-mark.svg`, `viewer/public/site.webmanifest` (`theme_color`/`background_color` = `#0e1311`)
- Modify: `sharer/index.html` `.about-logo-icon` SVG → Icon A (inline, ohne `<text>`)
- Test: `sharer/src-tauri/src/lib.rs` (neuer Unit-Test), `viewer/tests/icons.test.ts`

- [ ] **Step 1: Failing tests**
  - Rust `tray_icon_png_decodes_to_32x32_rgba`: `include_bytes!("../icons/32x32.png")` dekodiert via `image` zu 32×32 (schützt den Tray-Pfad in `lib.rs:2055`).
  - `icons.test.ts`: `app-icon.svg` und `brand-mark.svg` enthalten kein `<text`; `site.webmanifest` Farben `#0e1311`; `brand-mark.svg` in viewer und dashboard byte-gleich.
- [ ] **Step 2: Fail verifizieren** (Manifest-Farbe, `<text>` im Mockup-Stand).
- [ ] **Step 3: Erzeugen.** SVG zeichnen, `cd sharer && npx tauri icon src-tauri/icons/app-icon.svg` (auf testbox), nur die fünf Dateien aus `tauri.conf.json` behalten (zusätzlich erzeugte Plattform-Ordner löschen). Favicons mit `rsvg-convert` oder `npx sharp-cli` aus derselben SVG (apple-touch-icon 180 px randlos ohne Ecken-Rundung, Grund `#0e1311`).
- [ ] **Step 4: Pass** — beide Tests, `cargo test --lib` auf testbox.
- [ ] **Step 5: Sichtprüfung** PNGs 32/128 per Read ansehen (Monitor erkennbar bei 32 px?).
- [ ] **Step 6: Commit** `feat(brand): Matrix-style Icon A for sharer and website`

---

### Task 9: Doku, Visual-Audit-Basis, CLAUDE.md, Memory

**Files:**
- Modify: `docs/frontend-patterns.md` (Abschnitt „Calm Fresh“ → „Dark Engineering“: Tokens-Quelle, Sync, Komponenten, Hell/Dunkel, Guard-Tests)
- Modify: `CLAUDE.md` („Calm Fresh“-Verweise; Quick Commands: `cd viewer && npm run tokens:sync   # design/tokens.css → viewer/public/tokens.css (Guard: tokens-sync.test.ts)`; Baseline-Zahlen nach Task 10)
- Modify: `viewer/tests/e2e/visual-audit.spec.ts`: `const BASE = process.env.AUDIT_BASE ?? "https://auffi.app";` und alle URLs aus `BASE` bilden
- Memory: `project_calm_fresh_design_system.md` durch `project_dark_engineering_design_system.md` ersetzen, MEMORY.md-Zeile anpassen

- [ ] **Step 1:** Visual-Audit-Änderung; `npx playwright test tests/e2e/visual-audit.spec.ts --list` zeigt unveränderte Testnamen.
- [ ] **Step 2:** Doku + CLAUDE.md schreiben; `grep -rn "Calm Fresh" CLAUDE.md docs/frontend-patterns.md` leer.
- [ ] **Step 3: Commit** `docs(design): document dark engineering system and token sync`

---

### Task 10: Gesamt-Gate, Sichtprüfung, Release 0.8.0

- [ ] **Step 1: Volle Gate auf testbox** (je Paket isoliert, wie Release-Gate): backend, viewer, dashboard, sharer-js, sharer-lib, `tsc --noEmit` ×4, clippy, `bash ops/tests/run-all.sh`, `npm run csp:check`, `npm run tokens:check`. Erwartet: alle ≥ Baseline, 0 fail.
- [ ] **Step 2: Visual-Audit gegen lokalen Stack** auf testbox: `./ops/smoke.sh`-Stack hochfahren, `AUDIT_BASE=http://127.0.0.1:<port> npx playwright test tests/e2e/visual-audit.spec.ts --workers=1`, alle PNGs (hell, dunkel, mobil) per Read durchsehen. Abbruchkriterium: weiße Inseln, unlesbarer Text, fehlende Schrift. Stack danach stoppen.
- [ ] **Step 3: Branch-Review** (`superpowers:requesting-code-review`), Befunde fixen.
- [ ] **Step 4: Release-Zug** mit `/buildreleaseAuffi` als **Minor 0.8.0**. Vorher GitHub-Actions-Workflows wieder einschalten (seit 2026-11-17 abgeschaltet; Liste in `~/.config/tb-ci/disabled-actions.tsv` auf testbox, nur die von `phash/auffi`), sonst baut der Tag-Push nichts. Website-Deploy erst nach grünen Distro- und Windows-Smokes, in einem Schritt mit `KNOWN_ASSETS` 0.8.0. Windows-Smoke mit Screenshot des neuen Sharer-UI + echtem Connect.
- [ ] **Step 5: Nach Deploy** Visual-Audit gegen prod (beide Modi), Cluster-Caddyfile-CSP synchron, `sitemap.xml`-lastmod, `bash ops/indexnow-ping.sh`. Actions danach wieder abschalten, falls der Nutzer das so will (fragen).
