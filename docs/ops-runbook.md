# Ops Runbook

Operational reference: release procedures, Docker/proxy topology, backup & restore, and the deploy-script internals. Referenced from `CLAUDE.md`. The everyday dev/test/build commands live in `CLAUDE.md` § Quick Commands — this file holds the heavier, less-frequent procedures.

## Rebrand Naming Inconsistencies (Intentional)

The project was rebranded from Screenie to Auffi in 2026-05. Most identifiers are now `auffi*`, but a few keep the old `screenie*` name to preserve persistent state on the production host. **Do not change these without a migration plan:**

- Server path `/opt/screenie` — kept; renaming would require stopping the stack and `mv`-ing the directory.
- Docker Compose project name on prod = `screenie` (auto-derived from `/opt/screenie`). Volume prefixes are `screenie_*` (e.g. `screenie_caddy-data`, `screenie_viewer-static`). Renaming would break Let's Encrypt cert persistence and trigger new-volume creation.
- `/var/log/screenie-health.log` cron-example path — existing cron entries continue logging to the same file.

Container names (`auffi-backend`, `auffi-caddy`, `auffi-coturn`, etc.), image names, env-var names (`AUFFI_BACKEND_WS` etc.), and TURN realm (`turn.auffi.app`) all use the new branding.

## Production Deploy

```bash
# Production deploy (to musikersuche@musikersuche.org:/opt/screenie)
./ops/deploy.sh                    # idempotent — Tests + Build + Transfer + Compose-Up + Config-Restart + Health + Image-Prune + Deploy-Log
./ops/deploy.sh --yes              # ohne Confirm (Diff-Preview wird trotzdem gezeigt)
./ops/deploy.sh --skip-tests       # Tests überspringen (selten — nur bei Test-Infra-Issues)
./ops/deploy.sh --notes "X"        # Note in /opt/screenie/.deploy-log
./ops/deploy.sh --dry-run          # zeigt alle Schritte, kein Side-Effect
./ops/deploy.sh --rollback         # auf vorletzten SHA aus dem Deploy-Log zurück
```

## OG-image Rebuild (Facebook/Twitter share preview)

```bash
# Source: ops/og-image.svg → viewer/public/og-image.png
# Needs: rsvg-convert + Roboto Black font (Arch: `ttf-roboto`); without
# Roboto the wordmark falls back to DejaVu and the layout shifts.
# After deploy, refresh Facebook's cache via the Sharing Debugger.
rsvg-convert -w 1200 -h 630 ops/og-image.svg -o viewer/public/og-image.png
```

## Sharer Release (Linux + Windows; no macOS)

**Zwei Wege:**
- **(a) CI per Tag-Push (empfohlen):** `git tag vX.Y.Z && git push origin vX.Y.Z` → `release.yml` ruft `build-sharer.yml` (baut **Linux + Windows** — seit PR #117 mit GStreamer-dev (Linux) + vcpkg-`libvpx`/`VCPKG_ROOT` (Windows)), baut das Backend-Image und erstellt das GH-Release automatisch. Vorher Version bumpen (Schritt 1 unten).
- **(b) Lokaler Linux-Build (schneller für reine Linux-Iteration):** s. Skript unten — der AppImage-Wrapper umgeht DT_RELR-Strip + Icon-Pfad auf rolling-release-Distros (auf ubuntu-24.04-CI nicht nötig).
- **Kein macOS:** der Sharer hat keinen macOS-Capture/-Input-Backend (`capture/mod.rs` nur Linux/Windows). Ein macOS-Build kompiliert nicht.

```bash
# 1) Bump version in sharer/src-tauri/{tauri.conf.json,Cargo.toml,package.json}
# 2) Build .deb + .rpm + .AppImage (AppImage needs the wrapper for the
#    DT_RELR + icon-path workarounds — see docs/footguns.md § AppImage-Build Footguns)
./ops/build-sharer-appimage.sh
# 3) GH-Release + asset upload
gh release create vX.Y.Z --title "vX.Y.Z — short summary" --notes "..." \
  sharer/src-tauri/target/release/bundle/deb/Auffi_X.Y.Z_amd64.deb \
  sharer/src-tauri/target/release/bundle/rpm/Auffi-X.Y.Z-1.x86_64.rpm \
  sharer/src-tauri/target/release/bundle/appimage/Auffi_X.Y.Z_amd64.AppImage
# 4) Bump filenames in viewer/public/download/index.html + the
#    KNOWN_ASSETS-Set in backend/src/downloads/handlers.ts
#    (Portable baut die CI seit v0.6.4 mit — aber `?tag=vX.Y.Z`-Pin nicht vergessen, s. unten)
# 5) ./ops/deploy.sh --yes
# Windows-Builds laufen jetzt im CI (release.yml / build-sharer.yml auf
# windows-latest, seit PR #117). Die separate Windows-Box / das gh-Issue-
# Template ist nur noch Fallback, falls die CI mal klemmt.
```

**Mixed-platform-release-Gotcha:** Sobald vX.Y.Z released ist, zeigt `/releases/latest/download/...` auf die NEUE Tag. Solange Windows-Assets noch nicht hochgeladen sind (Windows-Build pending), wuerden die 3 Windows-Download-Buttons auf `/download/` als 404 antworten. Workaround: in `viewer/public/download/index.html` die 3 Windows-hrefs temporaer auf `/releases/download/v<PREVIOUS>/...` explizit pinnen (statt `/releases/latest/download/...`). Sobald der Windows-Sync-Commit landet: wieder auf `/latest/` zurueckstellen. Beispiel: Commit f34a445 (pin auf v0.4.1) + 5be400b (zurueck auf latest fuer v0.4.2).

**CLEANER METHOD (used for v0.5.0) — cut Linux-first as a PRE-RELEASE:** `gh release create vX.Y.Z --prerelease ...` (Linux assets only). A prerelease is NOT returned by GitHub's `/releases/latest`, so BOTH the download-proxy default (`releases/latest/download`) and the sharer update-notifier (`update_check.rs` → `/releases/latest`) stay on the previous full release — no download-page 404s, no update-loop, no temp Windows-pin. When the Windows build lands: `gh release edit vX.Y.Z --latest` to promote, together with the download-page + KNOWN_ASSETS bump + `./ops/deploy.sh`.

**FOOTGUN:** `github.com/.../releases/latest/download/<asset>` (the web redirect) propagates a few minutes BEHIND the `/releases/latest` API after you create or `--prerelease`-toggle a release. The proxy can throw transient 502s for latest-routed assets in that window (the API already shows the right tag). It self-heals — don't redeploy in a panic. `?tag=vX.Y.Z` resolves immediately.

**Portable-.exe (seit v0.6.4 von CI gebaut):** `build-sharer.yml` stagt nach `tauri:build` die unbundled `target/release/auffi-sharer.exe` (heißt nach dem Cargo-Package, NICHT `Auffi.exe`/productName) als `Auffi_X.Y.Z_x64_portable.exe` und lädt sie mit den Windows-Bundles hoch → `release.yml` (globt `windows/**`) hängt sie automatisch ans Tag-Release. Kein Handbuild mehr nötig. **Aber** das Portable ist NICHT latest-getrackt → `KNOWN_ASSETS`-Eintrag + Download-Button-href müssen **auf `?tag=vX.Y.Z` gepinnt** sein, sonst 502t der „Portable (.exe)"-Button (Asset nicht auf `/releases/latest`). Der Rest (KNOWN_ASSETS + Button-Wiring) bleibt manuell im Release-Commit.
> **Alt (vor v0.6.4 / falls CI mal klemmt):** Portable lokal auf Windows bauen, dann (a) `gh release upload vX.Y.Z …/Auffi_X.Y.Z_x64_portable.exe`, (b) `SHA256SUMS` um die Hash-Zeile ergänzen und `--clobber` neu hochladen — **die lokale Datei MUSS exakt `SHA256SUMS` heißen** (sonst legt `gh` ein Zweit-Asset an statt zu überschreiben). Beispiele: v0.6.3 = f487524 (manueller Upload); der alte generische Name `auffi-sharer-windows-x64.exe` war ein früherer 502-Verursacher.

**Ein veröffentlichter Tag bleibt bei einem Commit.** Ist ein Release defekt: `gh release edit vX.Y.Z --prerelease` (nimmt es aus `/releases/latest` → Update-Notifier fällt auf das vorige volle Release zurück), dann den nächsten Patch schneiden. Tag NICHT neu bespielen — sonst zeigt kein Bisect und kein Bug-Report mehr verlässlich auf denselben Code. So mit v0.6.8 → v0.6.9 verfahren (v0.6.8 war ohne Keyframe-Throttle + ICE-Teardown gebaut worden).

**Der Versions-Bump fasst nur `href=` und `softwareVersion` an.** Install-Befehle (`msiexec /i …`, `dpkg -i`, `rpm -i`, AppImage-`chmod`), Versions-Badge und der `/releases/tag/`-Link müssen mitgezogen werden — aber NUR oberhalb der ersten `<h3>X.Y.Z (…)`-Changelog-Überschrift, sonst frisst ein pauschales Replace die Changelog-Einträge (so passiert in v0.6.7). Guard: `viewer/tests/marketing-pages.test.ts`.

## Windows-Emulator-Smoke (`.win-test/`)

dockur/windows (QEMU-in-Docker, braucht `/dev/kvm`) bootet ein Windows 11. Beim allerersten Boot läuft `oem/install.bat` (OOBE, als Administrator) und registriert nur einen Logon-Task; der führt bei **jedem** Boot `oem/smoke.bat` aus. `oem/` ist zusätzlich unter `/data/oem` in die Freigabe (`\\host.lan\Data`) gemountet — der Smoke ist damit immer die aktuelle Fassung, ohne Windows neu zu installieren. Der Smoke installiert die MSI still, startet Portable und NSIS-Setup, prüft je Installer Prozess + `ProductVersion` des Binaries gegen `share/version.txt` und schreibt `share/install-result.txt` (`RESULT=PASS|FAIL|SKIP`, Kopfzeile trägt die Version).

```bash
.win-test/run.sh v0.7.1                 # Assets von GitHub laden + SHA256SUMS prüfen, VM (neu)starten, auf RESULT warten — warm ≈ 4 min
.win-test/run.sh v0.7.1 --keep-running  # letzte App-Instanz offen lassen → Screenshot / Live-Verbindungstest
.win-test/run.sh v0.7.1 --fresh         # VM-Disk verwerfen → frisches Windows (ISO via Mirror + Setup ≈ 15–60 min)
.win-test/run.sh v0.7.1 --no-download   # share/ ist schon bestückt (z. B. lokaler Build)
node .win-test/screenshot.mjs [out.png] [--click X,Y] [--type TEXT] [--key Enter]   # VM-Bildschirm via noVNC; Klick in Screenshot-Pixeln
```

- **Warm halten.** Die VM-Disk (Volume `auffi-wintest_auffi-win-data`) ist der Unterschied zwischen vier Minuten und einer Stunde. `docker compose stop` gibt die 4 GB RAM frei und behält die Disk; `down -v` nur, wenn ein wirklich frisches Windows gebraucht wird (z. B. Zertifikatsspeicher-Test wie 0.6.6).
- **RAM.** Die VM braucht 4 GB; `run.sh` verweigert den Start unter 4,6 GB `MemAvailable` (dockur drosselt sonst `RAM_SIZE`, die OOBE hängt). Nachbar-VMs (`t2cw-windows`, PraxisZeit) vorher stoppen.
- **Reichweite.** Beweist Installation + Start + Version je Installer. „kein Debug-Log in 25 s" heißt: Capture/Connect sind NICHT abgedeckt. Dafür `--keep-running` und dann `screenshot.mjs`: zeigt die App den 9-stelligen Code, stehen TLS-Trust + WSS gegen auffi.app (die 0.6.6-Lektion: installiert ≠ verbunden). Mit `--click` lässt sich der Akzeptieren-Dialog aus dem Screenshot heraus bedienen — so ist ein echter Ad-hoc-Connect Windows → Browser möglich.
- **Ergebnis lesen.** `run.sh` wartet auf eine Ergebnisdatei mit genau der angeforderten Version in der Kopfzeile — ein alter Lauf kann nicht als neuer durchgehen. Bei Timeout: noVNC `http://127.0.0.1:8007` (nur Loopback) und `share/first-boot.txt` ansehen.
- **Gotchas.** `.bat` müssen CRLF sein (`sed -i 's/\r*$/\r/'`); Klammern in `echo`-Text innerhalb von `( … )`-Blöcken killen cmd — Paren-Balance + goto-Labels vor dem Boot prüfen (`run.sh` tut das nicht). Microsofts Direkt-Download ist von dieser IP geblockt, dockur fällt auf einen Mirror zurück. Explizites compose-`name:` bleibt Pflicht, sonst räumt `up` den t2cw-Container als „Orphan" ab.

## Admin-Promote auf prod

`sqlite3`-Binary ist NICHT im backend-Image, also via Node + better-sqlite3 (ist schon installiert) auf der DB unter `/var/lib/auffi/auffi.db`. SQLite-WAL ist sicher fuer einen einzelnen Live-Writer, der UPDATE ist atomic; Backend muss NICHT gestoppt werden.

```bash
ssh musikersuche@musikersuche.org 'docker exec auffi-backend node -e "
const Database = require(\"better-sqlite3\");
const db = new Database(\"/var/lib/auffi/auffi.db\");
const before = db.prepare(\"SELECT id, email, admin FROM accounts WHERE email = ?\").get(\"EMAIL_HIER\");
console.log(\"before:\", JSON.stringify(before));
db.prepare(\"UPDATE accounts SET admin = 1 WHERE email = ?\").run(\"EMAIL_HIER\");
const after = db.prepare(\"SELECT id, email, admin FROM accounts WHERE email = ?\").get(\"EMAIL_HIER\");
console.log(\"after :\", JSON.stringify(after));"'
```

## Docker Conventions

- Each component that runs on a server has its own `Dockerfile` (multi-stage build).
- Root `docker-compose.yml` for local dev (backend + dependencies).
- Root `docker-compose.prod.yml` for production (backend + coturn + reverse proxy + Let's Encrypt + optional DB).
- Use **pinned image tags** (e.g. `node:22.22.2-alpine3.23` in `backend/Dockerfile`), never `latest`.
- Health checks defined for every long-running service.
- No secrets in `Dockerfile` or images. Configuration via env vars from `.env` (gitignored).

## Reverse Proxy

**Caddy** for TLS + Let's Encrypt + native WebSocket support. Two production modes:

- **Standalone** — `docker-compose.prod.yml` brings up our own Caddy on :80/:443.
- **Cluster** (current prod) — `docker-compose.prod.yml` + `docker-compose.cluster.yml` overlay. Our Caddy is disabled; the cluster's shared Caddy at `/opt/caddyserver/Caddyfile` reverse-proxies `auffi.app` to `auffi-backend:8080` via the external `caddy-proxy` network. The `viewer` runs as a small nginx-alpine sidecar serving the static dist.

TURN certs are shared via the `turn-cert-stage` sidecar copying from the Caddy cert volume to `turn-certs-staged`.

### CSP script-src after adding marketing pages

**`deploy.sh` does NOT ship the Caddyfile in cluster mode** (see § Cluster-Ops Footguns in `docs/footguns.md`). Every new batch of marketing pages adds JSON-LD inline scripts whose SHA-256 hashes must be whitelisted in the cluster Caddyfile's `Content-Security-Policy script-src` or the structured-data blocks will be CSP-blocked.

**2026-06-23 SEO push:** added 8 new marketing pages (DE + EN) — RustDesk, Chrome Remote Desktop, TeamViewer commercial-use, no-install screen sharing. After `./ops/deploy.sh`, patch the cluster Caddyfile manually:

1. On the prod host, recompute the full hash set from the deployed viewer HTML:
   ```bash
   python3 -c "import re,hashlib,base64,glob; files=['viewer/index.html','viewer/en/index.html']+sorted(glob.glob('viewer/public/**/index.html',recursive=True)); print('\n'.join(sorted({'sha256-'+base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() for f in files for m in re.findall(r'<script(?:\\s[^>]*)?>(.*?)</script>', open(f).read(), re.DOTALL) if m.strip() and 'src=' not in m[:60]})))"
   ```
   (same one-liner as in `caddy/Caddyfile` § comment — run from a repo checkout root, where `viewer/` is a direct child directory)
2. Replace the `sha256-…` tokens in `/opt/caddyserver/Caddyfile`'s `script-src` with the new set.
3. Validate and restart: `docker exec caddy-proxy caddy validate --config /etc/caddy/Caddyfile && docker restart caddy-proxy`.

The repo-side `caddy/Caddyfile` always carries the current full hash set. `viewer/tests/marketing-seo.test.ts` is the guard that keeps it in sync with the HTML sources — if it passes in CI, the repo Caddyfile is correct; the cluster file needs the same tokens applied by hand.

## Daily Backup

Cron-Job auf prod (installiert 2026-05-18): `15 4 * * * /opt/screenie/ops/backup.sh >> /opt/backup/auffi/backup.log 2>&1`. Script-Quelle im Repo: `ops/backup.sh`. Wird bei jedem `./ops/deploy.sh` automatisch nach `/opt/screenie/ops/backup.sh` gerollt (separate `maybe_run`-Schritte). Für Ad-hoc-Runs ohne Deploy: `./ops/maintenance.sh backup`. Das Backup-Log liegt nur auf prod (`/opt/backup/auffi/backup.log`) — bei starkem Wachstum mit `logrotate` aufräumen.

**Was gesichert wird, jede Nacht 04:15:**
- `/var/lib/auffi/auffi.db` — konsistenter Snapshot via `better-sqlite3 .backup()` (Online-Backup-API, kein Backend-Stop nötig, WAL-Inhalt wird mit eingerechnet). Output: `auffi-db_YYYY-MM-DD_HHMMSS.db.gz`.
- Cluster-Caddy-Volumes `caddyserver_caddy_data` + `caddyserver_caddy_config` (Let's-Encrypt-Account + ausgestellte TLS-Certs für auffi.app, www.auffi.app, turn.auffi.app — UND Certs anderer Cluster-Tenants, weil das Volume shared ist). Output: `auffi-caddy_YYYY-MM-DD_HHMMSS.tar.gz`. **Wichtig:** im Cluster-Modus liegen die echten LE-Certs hier, NICHT im `screenie_caddy-data`-Volume — das ist im Cluster-Setup tot (siehe `docs/footguns.md` § Cluster-Ops Footguns).

**Retention:** 7 Tage (`find -mtime +7 -delete`). Zielordner `/opt/backup/auffi/` rolling, max ~14 Dateien (7×DB + 7×Caddy) + `backup.log`.

**Was NICHT gesichert wird:** `viewer-static` / `dashboard-dist` (fallen aus `./ops/deploy.sh`), `turn-certs` (vom `turn-cert-stage`-Sidecar aus caddy-data abgeleitet), Container-Images (liegen in der GH-Release).

**Restore — SQLite-DB** (atomic via Volume-mounted ephemeral Container — vermeidet `docker cp` auf einen gestoppten Container und braucht kein sudo auf dem Host):
```bash
# 0) Auf dem Prod-Host (oder via SSH dort):
TS=2026-05-18_041501   # gewünschter Backup-Timestamp
cd /opt/backup/auffi
gunzip -kc auffi-db_${TS}.db.gz > /tmp/restore.db   # -k = keep .gz
# 1) Backend stoppen (Cluster-overlay nutzen wenn aktiv):
docker compose -f /opt/screenie/docker-compose.prod.yml \
  -f /opt/screenie/docker-compose.cluster.yml \
  --env-file /opt/screenie/.env.prod stop backend
# 2) Atomic-mv im Volume via ephemerer Container — alpine mountet das
#    Volume, sieht die Live-DB unter /db/, schreibt die wiederhergestellte
#    Version atomar dorthin.
docker run --rm -v screenie_auffi-db:/db -v /tmp:/src alpine:3 sh -c '
  cp /db/auffi.db /db/auffi.db.bak-$(date +%s) &&
  cp /src/restore.db /db/auffi.db &&
  rm -f /db/auffi.db-wal /db/auffi.db-shm
'
# 3) Backend starten:
docker compose -f /opt/screenie/docker-compose.prod.yml \
  -f /opt/screenie/docker-compose.cluster.yml \
  --env-file /opt/screenie/.env.prod start backend
# 4) /tmp/restore.db löschen (PII!).
rm -f /tmp/restore.db
```

**Restore — Caddy-Certs (auffi-only):** das Tarball enthält Certs aller Cluster-Tenants. Beispiel-Pfad-Struktur:
```
./data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/auffi.app/auffi.app.{crt,key,json}
./data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/www.auffi.app/...
./data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.auffi.app/...
```
```bash
TS=2026-05-18_041501
mkdir -p /tmp/caddy-restore && cd /tmp/caddy-restore
tar xzf /opt/backup/auffi/auffi-caddy_${TS}.tar.gz
# Nur Auffi-relevante Subordner in das LIVE-Cluster-Volume zurücktragen:
docker run --rm \
  -v "$(pwd)/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory:/src:ro" \
  -v caddyserver_caddy_data:/dst alpine:3 sh -c '
    mkdir -p /dst/caddy/certificates/acme-v02.api.letsencrypt.org-directory &&
    cp -a /src/auffi.app /src/www.auffi.app /src/turn.auffi.app \
      /dst/caddy/certificates/acme-v02.api.letsencrypt.org-directory/
'
# caddy-proxy neu laden (admin-API ist off, also restart — 3s blip,
# cluster-shared, siehe docs/footguns.md § Cluster-Ops Footguns):
docker restart caddy-proxy
rm -rf /tmp/caddy-restore
```

Optionaler off-site Sync via `BACKUP_REMOTE_TARGET=user@host:/backups/auffi/` env-var (rsync, im Script bereits eingebaut, aktuell nicht gesetzt). User stellt den SSH-Key out-of-band bereit — kein Key im Repo.

## GeoIP MMDB Monthly Bump

The `geoip` build stage in `backend/Dockerfile` pins `DBIP_MONTH` (e.g. `2026-06`) to a specific
DB-IP monthly snapshot. DB-IP rolls old monthly files after a few months, so the build fails loudly
with a `wget` 404 if the pinned month is no longer available — this is intentional: a failed
download is noticed at deploy time, not silently at lookup time.

**To bump:** edit the `ARG DBIP_MONTH=` line in `backend/Dockerfile` to the current month
(`YYYY-MM`), commit, and redeploy. Source: DB-IP IP-to-Country Lite (CC-BY-4.0,
https://db-ip.com).

## Deploy-Skript-Robustheit

`./ops/deploy.sh` (Refactor 2026-05-20) macht weit mehr als rsync + compose up. Was passiert in welcher Reihenfolge:

1. **flock auf `/tmp/auffi-deploy.lock`** — verhindert parallele Deploys.
2. **Trap-Cleanup** für lokale Image-Tarballs auch bei Abort.
3. **Pre-flight nginx -t** auf `nginx/auffi-viewer.conf` + `auffi-dashboard.conf` via ephemerem nginx-Container, **caddy validate** auf `caddy/Caddyfile` (standalone only). Kaputte Configs scheitern HIER, nicht erst beim Container-Start.
4. **Pre-deploy Tests**: viewer + backend (~25s). Sharer-Tests bewusst draußen (Desktop-App, separater Release-Flow, cargo cold-build dauert ~5min). Override via `--skip-tests`.
5. **Diff-Preview**: liest letzten SHA aus `/opt/screenie/.deploy-log`, zeigt `git log <last>..HEAD --oneline` + `git diff --stat <last>..HEAD`. Confirm vor dem Deploy (Skip mit `--yes`).
6. **Build backend** — übersprungen wenn `auffi-backend:${SHA}` bereits remote existiert (`docker image inspect`-Check). Spart bei Re-Deploys den 60s-Build.
7. **Build viewer + dashboard** — `npm ci` wird übersprungen wenn `package-lock.json`-Hash gleich dem letzten Build (`.deploy-cache-hash` in `node_modules/`). `npm run build` läuft immer (ist eh schnell).
8. **Image-Transfer** (skipped wenn schon remote), Tarball-Cleanup via Trap.
9. **Config-Hash-Diff**: sha256 von `nginx/*.conf`, `coturn/turnserver.conf.tmpl`, `caddy/Caddyfile` lokal vs prod. Geänderte Configs → Service-Restart-Liste.
10. **rsync** der Configs + Compose + Dist + ops/backup.sh.
11. **`docker compose up -d --remove-orphans`** — recreatet bei Image-/Compose-Spec-Änderung.
12. **Service-Restart** für die in Schritt 9 markierten Container — **fixt den Single-File-Bind-Mount-Stale-Bug**, wo nginx-Config-Updates ohne Container-Restart nicht aktiv werden (kennen wir aus dem 2026-05-19-Soft-404-Fix).
13. **Health-Checks**: `/healthz`, `/`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, plus eine 404-URL die als 404 zurückkommen MUSS. Eine Abweichung scheitert den Deploy (hardfail).
14. **Image-Prune** auf prod: `docker rmi` aller `auffi-backend:*`-Tags außer den 3 neuesten + `:latest`. Override mit `--skip-image-prune`.
15. **Deploy-Log-Append** an `/opt/screenie/.deploy-log` (Format: `ISO8601-UTC\tsha\tdeployer@host\tnotes`).

15b. **Release-Snapshot** nach `/opt/screenie/releases/<sha>/` (viewer-dist, dashboard-dist, nginx/, coturn/, standalone auch caddy/) — erst nach Health-Check + Log-Append, damit nur gesunde Deploys einen Snapshot haben. Der Prune in Schritt 14 hält Snapshots für dieselben 3 SHAs wie die Images.

**Rollback** (`./ops/deploy.sh --rollback`): liest vorletzten SHA aus Deploy-Log, prüft dass dessen Image noch da ist, setzt `APP_VERSION` in `.env.prod` um, retagged `:latest`, spielt den Release-Snapshot zurück (rsync --delete in die Bind-Mount-Verzeichnisse; standalone zusätzlich Copy ins `viewer-static`-Volume), `compose up -d`, `docker restart` für auffi-dashboard + auffi-coturn (+ auffi-viewer im Cluster / auffi-caddy standalone — Single-File-Bind-Mount-Stale-Fix wie Schritt 12), dann dieselben Smoke-Checks wie Schritt 13. Voraussetzung: Image + Snapshot waren noch nicht vom Prune erwischt — also nutzbar für die letzten 3 Deploys. **Ohne Snapshot** (SHA vor 0.7.1 deployed) wird NUR das Backend-Image zurückgesetzt — das Skript warnt; Frontend-/Config-Regressionen dann via `git checkout <sha> && ./ops/deploy.sh --version <sha>`.

**Wenn ein Restart-Trigger fehlt**: Service-Restart-Liste in Schritt 9 ist allowlist-basiert. Wenn ein NEUER bind-mounteter File-Pfad hinzukommt, der einen Container-Restart braucht (zB ein neuer `nginx/something.conf`), MUSS er in Schritt 9 in `deploy.sh` ergänzt werden. Sonst landet die neue Config zwar via rsync auf prod, der Container bleibt aber an der alten Inode hängen.
