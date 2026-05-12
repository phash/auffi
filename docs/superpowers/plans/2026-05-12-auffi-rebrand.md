# Auffi.app Rebrand & Migration Plan

**Datum:** 2026-05-12
**Ziel:** Screenie → Auffi.app rebranden (Code, Server, Domain) mit hartem Cutover.
**Status:** Plan, noch nicht in Ausführung.

## Entscheidungen (vorab geklärt)

| Bereich | Entscheidung |
|---|---|
| GitHub-Repo | `phash/screenie` → `phash/auffi` umbenennen (GitHub legt automatische Redirects an) |
| Domain-Migration | **Harter Cutover** — `screenie.mr-development.de` wird abgeschaltet, nicht parallel betrieben |
| Server-Pfade | `/opt/screenie` bleibt — Caddy-Cert-Volume + Compose-State bleiben erhalten |
| DNS-Records | `auffi.app` (Apex), `turn.auffi.app`, `www.auffi.app` |

## Hauptrisiko: Sharer-Installationen werden tot beim Cutover

Bestehende `.deb`/`.rpm`/`.AppImage`-Installationen haben `wss://screenie.mr-development.de/signal` fest einkompiliert (via `option_env!("SCREENIE_DEFAULT_BACKEND_WS")`). Auto-Update existiert nicht. Wenn echte Bestandsnutzer existieren, müssen wir **vor** dem Cutover ein neues Release (v0.2.0 mit Auffi-Branding) veröffentlichen und sie zum manuellen Update auffordern. Wenn nur du der einzige Nutzer bist, ist das Risiko egal — du installierst halt einmal neu.

→ Annahme im Plan: aktuell keine externen Bestandsnutzer. Falls doch, Phase 2 (Pre-Release) vor Phase 5 (Cutover) zwingend ausführen.

## Reichweite (kartierte Treffer)

Gefunden via grep (ohne node_modules, dist, target, coverage):

- **Sharer Rust** — `tauri.conf.json` (productName, identifier, window titles), `Cargo.toml`, `src-tauri/src/lib.rs` (2× `SCREENIE_DEFAULT_BACKEND_WS` Default), `src-tauri/src/signaling.rs` (`SCREENIE_SHARER_ORIGIN` env), `border.html`-Window-Title `screenie-active`
- **Sharer TS** — `package.json`, evtl. Branding im HTML
- **Backend** — `package.json`, kein Hard-Code von Domain (ALLOWED_ORIGINS kommt aus env), Pino-Logger-Name
- **Viewer** — `package.json`, `index.html` `<title>` + Branding, `tests/e2e/production.spec.ts` mit `PROD_VIEWER=https://screenie.mr-development.de`
- **Docker** — `docker-compose.{prod,cluster,smoke}.yml` (TURN_REALM-Defaults, Kommentare, Container-Namen `screenie-backend`, `screenie-viewer`, `screenie-coturn`)
- **Caddy** — `caddy/Caddyfile` (Site-Block `screenie.mr-development.de`, CSP mit `wss://screenie.mr-development.de`)
- **coturn** — `turnserver.conf.tmpl`, `entrypoint.sh` lesen nur env → keine Code-Änderung
- **Ops** — `ops/lib.sh` (`DEPLOY_DOMAIN`, `DEPLOY_TURN_DOMAIN` Defaults), `ops/smoke.sh`, `ops/deploy.sh`
- **Scripts** — `scripts/install-linux.sh` (Viewer-URL in Info-Output)
- **Tests** — `backend/tests/turn-credentials.test.ts` benutzt `turn.screenie.local` (rein lokal, kann mitumbenannt werden)
- **Docs** — `README.md`, `INSTALL-LINUX.md`, `CLAUDE.md`, `docs/protocol.md`, `docs/smoke-test-prod.md`, `docs/security-review-2026-05-11.md`
- **CI** — `.github/workflows/ci.yml` (lokale env, fine; aber Repo-Name evtl. in Badges)

## Phasenplan

### Phase 0 — IONOS DNS-Records anlegen (USER, mit Anleitung)

Muss **zuerst** passieren, damit Caddy nachher Let's-Encrypt-Cert holen kann. Propagation ~30 min – 24 h.

**IONOS-Schritte:**

1. https://www.ionos.de → Login → "Mein Konto"
2. "Domains & SSL" → in der Liste `auffi.app` anklicken
3. Reiter "DNS" öffnen
4. Folgende vier Records anlegen (alle TTL 1 h):

   | Typ | Hostname | Wert | Notiz |
   |---|---|---|---|
   | A | `@` (oder leer für Apex) | `82.165.40.140` | IONOS VPS |
   | A | `turn` | `82.165.40.140` | TURN-Server |
   | A | `www` | `82.165.40.140` | Redirect-Target |
   | CAA | `@` | Flags `0`, Tag `issue`, Wert `letsencrypt.org` | Optional, aber best practice — sperrt fremde CAs aus |

5. **Wichtig:** Kein "Web-Forwarding" / "Webspace-Paket"-Verknüpfung aktivieren. Falls IONOS vorab eine Parking-Page oder Forwarding angelegt hat: löschen.
6. Verifikation (alle drei müssen `82.165.40.140` zurückgeben):
   ```bash
   dig +short auffi.app @1.1.1.1
   dig +short turn.auffi.app @1.1.1.1
   dig +short www.auffi.app @1.1.1.1
   ```

### Phase 1 — Code-Rebrand (Feature-Branch `chore/rebrand-auffi`)

Atomare Commits per Komponente (Conventional Commits, wie in CLAUDE.md gefordert):

**1a `chore(sharer): rebrand to Auffi`**
- `tauri.conf.json`: `productName: "Auffi"`, `identifier: "app.auffi.desktop"`, Window-Title `"Auffi — Sharer"`, border-window-title `"auffi-active"`
- `src-tauri/Cargo.toml`: `name = "auffi-sharer"`
- `src-tauri/src/lib.rs`: Default-WS `wss://auffi.app/signal`, env-Var-Namen bleiben `SCREENIE_*` (nur Werte ändern wäre auch eine Option, aber Namens-Konsistenz besser — also `AUFFI_DEFAULT_BACKEND_WS`, `AUFFI_SHARER_ORIGIN`). dbg_log-Pfad: `/tmp/auffi-debug.log`.
- `src-tauri/src/signaling.rs`: env-Lookup `AUFFI_SHARER_ORIGIN`
- `package.json`: `name: "auffi-sharer"`
- `src/`: UI-Branding (falls "Screenie" als Text irgendwo gerendert wird)

**1b `chore(backend): rebrand to Auffi`**
- `package.json`: `name: "auffi-backend"`
- `src/server.ts`: Pino-Logger `name: "auffi"`
- Tests: `turn.screenie.local` → `turn.auffi.local` (rein lokale Test-Konstanten)

**1c `chore(viewer): rebrand to Auffi`**
- `package.json`: `name: "auffi-viewer"`
- `index.html`: `<title>Auffi</title>`, Branding-Strings ("Screenie" → "Auffi", "Helfer" Wording bleibt)
- `tests/e2e/production.spec.ts`: `PROD_VIEWER`, `PROD_SIGNAL` auf `auffi.app`

**1d `chore(docker): rebrand containers and compose project`**
- Compose-Project: `screenie` → `auffi` via `name:` Feld in jeder Compose-Datei (oder `-p auffi` Flag im Deploy-Skript)
- Container-Namen: `screenie-backend` → `auffi-backend`, dito viewer, coturn, caddy
- **Volumes nicht umbenennen** — `screenie_caddy_data` etc. bleiben, damit LE-Certs erhalten bleiben. Diese Inkonsistenz dokumentieren in CLAUDE.md.
- `docker-compose.cluster.yml`: Kommentar-Block updaten, `TURN_REALM`-Default `turn.auffi.app`, Network-Name `cluster-proxy` bleibt (extern)
- `docker-compose.prod.yml`: TURN_REALM-Default `turn.auffi.app`, Kommentar-Block

**1e `chore(caddy): rebrand site block to auffi.app`**
- `caddy/Caddyfile`: Site-Header `auffi.app, www.auffi.app`, CSP mit `wss://auffi.app wss://turn.auffi.app:5349`, Rate-Limit-Zonen-Namen `auffi_general` / `auffi_turn`
- Separater Site-Block für `www.auffi.app` → 301 auf `https://auffi.app{uri}` (nur falls Standalone-Caddy genutzt wird; im Cluster-Modus macht das die Cluster-Caddyfile)

**1f `chore(ops): rebrand deploy defaults`**
- `ops/lib.sh`: `DEPLOY_DOMAIN="auffi.app"`, `DEPLOY_TURN_DOMAIN="turn.auffi.app"`
- `ops/smoke.sh`: bleibt localhost-basiert, keine Änderung
- `ops/deploy.sh`: SSH-Target weiterhin `musikersuche@musikersuche.org`, Remote-Pfad `/opt/screenie` bleibt

**1g `chore(scripts): rebrand installer URLs`**
- `scripts/install-linux.sh`: Viewer-URL-Info auf `https://auffi.app`, GitHub-Raw-URL bleibt vorerst (Repo-Rename folgt; GitHub-Redirect fängt das ab)

**1h `docs: rebrand to Auffi`**
- `README.md`, `INSTALL-LINUX.md`, `CLAUDE.md`, `docs/protocol.md`, `docs/smoke-test-prod.md`: Produktname + Domain ersetzen
- CLAUDE.md `Quick Commands`: Volume-Name-Inkonsistenz dokumentieren ("Volumes heißen weiterhin `screenie_*`, das ist Absicht")

**Sanity-Check vor PR:**
```bash
grep -rn "Screenie\|screenie\.mr-development\|SCREENIE_" \
  --include="*.{ts,rs,json,toml,yml,sh,html,md}" \
  . | grep -v node_modules | grep -v dist | grep -v target | grep -v coverage
```
Erwartet: nur noch beabsichtigte Überbleibsel (Volume-Namen, evtl. Changelog-Einträge).

### Phase 2 — Pre-Release Sharer v0.2.0 (nur falls externe Nutzer existieren)

- Tag `v0.2.0` auf dem rebrand-Branch
- GitHub Release mit `.deb`, `.rpm`, `.AppImage`
- Release-Notes: "Auffi.app Rebrand — bestehende Installationen bitte updaten, alte Domain wird in X Tagen abgeschaltet"
- Wenn du der einzige Nutzer bist: überspringen.

### Phase 3 — Cluster-Caddy neue Site aktivieren (auffi.app live)

Auf `musikersuche@musikersuche.org`:

1. Backup: `cp /opt/caddyserver/Caddyfile /opt/caddyserver/Caddyfile.pre-auffi`
2. Neuen Site-Block für `auffi.app` + `www.auffi.app` parallel zum existierenden screenie-Block einfügen (Cluster-Caddyfile, nicht repo-Caddyfile):
   ```caddy
   auffi.app {
     # … gleicher Inhalt wie screenie-Block, aber alle screenie-Referenzen ersetzt
     reverse_proxy /signal screenie-backend:8080
     reverse_proxy /turn-credentials screenie-backend:8080
     # … etc
     root * /opt/screenie/viewer-dist
   }

   www.auffi.app {
     redir https://auffi.app{uri} permanent
   }
   ```
   (Backend-Container-Name bleibt `screenie-backend` bis Phase 1d deployt ist; danach `auffi-backend`. Ordering also: erst Phase 1 + Deploy, dann Phase 3.)
3. `docker exec caddy-proxy caddy validate --config /etc/caddy/Caddyfile`
4. `docker exec caddy-proxy caddy reload --config /etc/caddy/Caddyfile`
5. Verifikation: `curl -I https://auffi.app/healthz` → 200; Cert via `openssl s_client -connect auffi.app:443 -servername auffi.app < /dev/null | openssl x509 -noout -issuer -dates`
6. Backend ALLOWED_ORIGINS temporär auf beide Domains setzen — in `/opt/screenie/.env` oder `docker-compose.cluster.yml`:
   ```
   ALLOWED_ORIGINS=https://auffi.app,https://screenie.mr-development.de
   ```
   Backend neu starten. So funktionieren beide Domains gleichzeitig — wichtig für den Test in Phase 5.

### Phase 4 — coturn auf turn.auffi.app umstellen

1. `.env` auf Server: `TURN_REALM=turn.auffi.app`, `TURN_HOSTS=turn:turn.auffi.app:3478,turns:turn.auffi.app:5349`
2. **Voraussetzung**: Cluster-Caddy hat bereits ein LE-Cert für `turn.auffi.app` geholt — das passiert automatisch, sobald `turn.auffi.app` als Site-Header irgendwo auftaucht. Falls nicht: einen Dummy-Site-Block `turn.auffi.app { respond "ok" 200 }` in der Cluster-Caddyfile anlegen.
3. `docker compose -f docker-compose.prod.yml -f docker-compose.cluster.yml up -d --force-recreate coturn turn-cert-stage`
4. Test: `turnutils_uclient -u testuser -w testpass turn.auffi.app -p 3478` (Credentials aus `/turn-credentials` Endpoint holen)

### Phase 5 — Cutover

Bedingung: Phase 0 (DNS) propagiert, Phase 1 (Code) deployt mit ALLOWED_ORIGINS=beide, Phase 3 (Caddy) live, Phase 4 (TURN) live.

End-to-End Test mit beiden Domains:
- Browser auf `https://auffi.app`, Sharer v0.2.0 starten, Code generieren, verbinden, Stream sehen, Eingabe testen, Datei senden
- Selber Test gegen `https://screenie.mr-development.de` — muss weiterhin funktionieren

Wenn Tests grün:
1. Cluster-Caddyfile: `screenie.mr-development.de`-Site-Block durch `redir https://auffi.app{uri} permanent` ersetzen
2. `caddy reload`
3. Backend `.env`: `ALLOWED_ORIGINS=https://auffi.app` (alte Domain raus)
4. Backend neu starten
5. Final-Test: `curl -I https://screenie.mr-development.de/` → 301 nach `auffi.app`; alter WSS-Endpoint verweigert Origin

### Phase 6 — GitHub-Repo umbenennen

1. `https://github.com/phash/screenie` → Settings → "Rename repository" → `auffi`
2. Lokal: `git remote set-url origin https://github.com/phash/auffi.git`
3. README-Badges, `scripts/install-linux.sh`-Raw-URLs prüfen — können erstmal alle weiter `phash/screenie` referenzieren (GitHub redirected automatisch), aber für Hygiene auf `phash/auffi` aktualisieren in einem `chore(repo): update repo URLs` Commit.
4. GitHub Actions Workflows funktionieren weiter (kein Repo-Name im Workflow).

### Phase 7 — Cleanup (nach ~1 Woche)

1. Cluster-Caddyfile: `screenie.mr-development.de` Redirect-Block entfernen
2. `caddy reload`
3. DNS-Records bei mr-development.de für `screenie` + `turn.screenie` können bleiben (zeigen ins Leere, harmlos) oder werden gelöscht.
4. MRD-API: Cluster-Projekt-Eintrag updaten (`screenie.mr-development.de` raus, `auffi.app` rein) — siehe `~/.claude/CLAUDE.md` für MRD-Endpoints
5. CLAUDE.md hat dann nur noch `auffi.app` Referenzen, kein Restmüll.

## Zeitplan-Vorschlag

| Tag | Aktion | Wer |
|---|---|---|
| **T+0** (jetzt) | Phase 0: IONOS-Records anlegen | du |
| T+0 | Phase 1: Code-Rebrand im Branch `chore/rebrand-auffi` | ich |
| T+0 oder T+1 | DNS-Propagation prüfen (`dig`) | du oder ich |
| T+1 | Phase 1 mergen + deployen | ich |
| T+1 | Phase 3 (Caddy), Phase 4 (TURN) auf Server | ich |
| T+1 | Phase 5 (E2E-Test + Cutover) | gemeinsam |
| T+1 | Phase 6 (Repo-Rename) | du |
| T+8 | Phase 7 (Cleanup) | ich |

## Definition of Done

- `https://auffi.app` zeigt Viewer, generiert Codes, Sharer v0.2.0 verbindet sich.
- `https://screenie.mr-development.de` 301-redirected auf `https://auffi.app` (Phase 5–7) bzw. ist tot (nach Phase 7).
- `turn.auffi.app:5349` (TURNS) liefert gültiges LE-Cert.
- GitHub-Repo heißt `phash/auffi`, alte URLs redirecten automatisch.
- Alle Tests grün (`npm test` in backend/viewer/sharer, `cargo test` im sharer).
- CLAUDE.md aktualisiert (Domain überall ersetzt, Volume-Inkonsistenz dokumentiert).
- Keine TODO/FIXME aus dieser Migration übriggeblieben.
