# Auffi — Project Conventions

## Product Goals

Three non-negotiable goals that **every** engineering decision should serve. When a design choice trades off, fall on the side of these.

1. **Einfache Steuerung** — A non-technical helper opens a URL, types a 9-digit code, clicks Verbinden. Done. The sharer-user clicks Akzeptieren, picks a monitor. Done. No accounts, no installs (for ad-hoc), no jargon in the UI, no settings the helper has to discover. German first.

2. **Verlässliche Verbindung** — The connection survives Wi-Fi blips (10 s ICE-disconnected grace), reuses the same session on reconnect within 30 s, falls back to TURN when P2P is blocked, and tears down predictably when something genuinely failed. The user should never see a stuck "Verbindung wird hergestellt…" without a path forward. Logs use `dbg_log()` so failures are diagnosable post-hoc.

3. **Sichere Kommunikation** — TLS everywhere (Let's Encrypt via Caddy). WebRTC media uses DTLS-SRTP, mandatory. Session codes are server-burned after 5 wrong attempts and TTL-capped at 10 minutes. Sharer always confirms incoming peers (except in the future unattended mode where the device-token + per-device password gate access). TURN credentials are HMAC-ephemeral. No PII in logs, no third-party trackers, argon2id for passwords, SHA-256 for at-rest token hashes. See `docs/security-review-2026-05.md` for the audit and `docs/encryption-architecture.md` for the end-to-end crypto-chain walkthrough.

**License:** AGPL-3.0-only (`LICENSE`). Forks that host Auffi as a service MUST publish their modifications under the same license — closes the SaaS-loophole of plain GPL-3.0. When new code lands in `backend/` / `viewer/` / `dashboard/` / `sharer/`, it MUST be AGPL-3.0-compatible (MIT, Apache-2.0, BSD are fine; GPL-2-only or proprietary SDKs are NOT).

## Project Overview

TeamViewer-style screen-sharing tool. Live at `https://auffi.app`. Four components in one monorepo:

- `backend/` — Node.js + Fastify WebSocket signaling server, REST `/api/*`, better-sqlite3. Dockerized.
- `viewer/` — Browser-based viewer (Vite + TypeScript). Static build, served by reverse proxy.
- `sharer/` — Tauri 2 native desktop app (Rust core + Webview UI). Supports both ad-hoc 9-digit-code flow and unattended-access mode (paired device, persistent WSS, optional `auto_accept`).
- `dashboard/` — Browser SPA for the unattended-access surface only (Vite + TypeScript). Account signup/verify/login, device pairing codes, device list. Not loaded for the ad-hoc flow.

Target deployment: Linux VPS, **everything runs in Docker** (backend, coturn, reverse proxy, optional DB).

**Wayland capture** goes through GStreamer (`pipewiresrc ! videoconvert ! BGRA ! appsink`) rather than direct `pipewire-rs` — the GStreamer element handles DMA-BUF / modifier negotiation that Plasma 6 rejects on the raw SHM path. See `sharer/src-tauri/src/capture/gst_portal.rs`.

**Entry points:**
- Backend: `backend/src/index.ts` → `server.ts` (Fastify) → `signaling.ts` (WS rooms) + `auth/`, `devices/`, `account/`, `admin/`, `feedback/`, `downloads/`, `tracking/` route modules. Notable: `admin/feedback.ts` (list/patch/reply/delete; reply persists BEFORE SMTP so transient mail failures keep the typed reply as a draft), `admin/stats.ts` (`/api/admin/stats` + `/api/admin/stats/codes`), `downloads/handlers.ts` (KNOWN_ASSETS-Allow-List — bump per release; `/api/downloads/file/:asset[?tag=vX.Y.Z]`-Stream-Proxy s. Download-Proxy-Footguns), `tracking/matomo.ts` (server-side code_created Matomo POST), `tracking/code_events.ts` (per-mint DB-Row in `code_events`-Tabelle, 365 d Retention via `purge.ts`).
- Viewer: `viewer/src/main.ts` → `ui.ts` (UI wiring) → `webrtc-client.ts` (peer) + `zoom.ts` + `pan.ts` (pure zoom/pan-state helpers). Plus `notch-connect.ts` (Verbinden-Notch in der Topbar) und `matomo-consent-decision.ts` (pure Decision-Table für den Consent-Banner). Static `viewer/public/` ships standalone vanilla-JS overlays (`feedback-fab.js`, `download/counts.js`, `matomo-consent.{js,css}`) that the 4 marketing-pages + dashboard link directly — they live outside the Vite-bundle so the static-pages can use them without TypeScript.
- Sharer: `sharer/src-tauri/src/lib.rs` (Tauri commands) → `capture/mod.rs` (per-OS capture) → `webrtc_peer.rs` (encoder/peer). Unattended path: `heartbeat.rs` (persistent WSS) + `unattended_cmd.rs` (Tauri commands + forwarder loop). Input pipeline `input.rs` — `InputController` tracks held buttons/keys and releases them in `Drop` (gh #97 fix; otherwise a viewer-disconnect mid-click leaves the OS thinking the button is still down). Update-Notifier: `update_check.rs` (Tauri command `check_for_update`, GitHub-Releases-API gegen `CARGO_PKG_VERSION`) + `sharer/src/update-banner.ts` (UI-Banner mit „Jetzt herunterladen"-Link auf auffi.app/download/).
- Dashboard: `dashboard/src/main.ts` → `router.ts` (history-API SPA) → `views/*.ts` (incl. `admin-feedback.ts` mit inline-reply UI, `admin-stats.ts` mit Users/Devices/Connections/Code-Mints inkl. perDay-Bar-Chart). Admin-Section (#53/#54): `admin-nav.ts` (`visibleRoutes` + `updateActiveNav` + `isAdminGatedPath` als pure Helper), `views/admin-overview.ts` (KPI-Tiles), `views/admin-users.ts` (Filter-Chips + cursor-Pagination + debounced Search), `views/admin-user-detail.ts` (Suspend/Promote/Delete + Audit-Trail), `views/admin-403.ts` (friendly "kein Admin"-Seite), `components/confirm-with-reason.ts` (reusable destruktives-Confirm-Modal, geteilte Convention für alle Admin-Aktionen). Plus `components/feedback-fab.ts`.
- Cross-component wire format: `docs/protocol.md` — both sides of every message reference this. The unattended-access additions (pw-attempt / pw-check / pw-check-result / unattended-hello / `confirmId` routing) are not yet in protocol.md; refer to `backend/src/protocol.ts` and `sharer/src-tauri/src/heartbeat.rs::BackendFrame|SharerFrame` until docs catch up.

Specs and plans live under `docs/superpowers/`.

## Quick Commands

```bash
# Backend (Fastify signaling)
cd backend && npm run dev          # tsx watch on :8080
cd backend && npm test             # vitest

# Viewer (browser SPA)
cd viewer && npm run dev           # vite on :5173
cd viewer && npm run build         # static dist/
cd viewer && npm run test:e2e      # Playwright

# Sharer (Tauri desktop app)
cd sharer && npm run tauri:dev     # native window + DevTools
cd sharer && npm run tauri:build   # .deb / .rpm / .AppImage
cd sharer/src-tauri && cargo test --lib                          # 188 Rust unit tests — note nested dir
cd sharer/src-tauri && cargo clippy --lib --tests -- -D warnings

# Dashboard (unattended-access SPA — only needed if you're working on the account/device flow)
cd dashboard && npm run dev        # vite on :5174
cd dashboard && npm test           # vitest (jsdom + custom router)
cd dashboard && npm run build      # static dist/

# Local stack (backend + coturn behind dev Caddy)
docker compose up --build

# Production deploy (to musikersuche@musikersuche.org:/opt/screenie)
./ops/deploy.sh                    # idempotent — Tests + Build + Transfer + Compose-Up + Config-Restart + Health + Image-Prune + Deploy-Log
./ops/deploy.sh --yes              # ohne Confirm (Diff-Preview wird trotzdem gezeigt)
./ops/deploy.sh --skip-tests       # Tests überspringen (selten — nur bei Test-Infra-Issues)
./ops/deploy.sh --notes "X"        # Note in /opt/screenie/.deploy-log
./ops/deploy.sh --dry-run          # zeigt alle Schritte, kein Side-Effect
./ops/deploy.sh --rollback         # auf vorletzten SHA aus dem Deploy-Log zurück

# OG-image rebuild (Facebook/Twitter share preview)
# Source: ops/og-image.svg → viewer/public/og-image.png
# Needs: rsvg-convert + Roboto Black font (Arch: `ttf-roboto`); without
# Roboto the wordmark falls back to DejaVu and the layout shifts.
# After deploy, refresh Facebook's cache via the Sharing Debugger.
rsvg-convert -w 1200 -h 630 ops/og-image.svg -o viewer/public/og-image.png

# Sharer release (Linux only — Windows needs separate build via gh issue)
# 1) Bump version in sharer/src-tauri/{tauri.conf.json,Cargo.toml}
# 2) Build .deb + .rpm + .AppImage (AppImage needs the wrapper for the
#    DT_RELR + icon-path workarounds — see "AppImage-Build Footguns")
./ops/build-sharer-appimage.sh
# 3) GH-Release + asset upload
gh release create vX.Y.Z --title "vX.Y.Z — short summary" --notes "..." \
  sharer/src-tauri/target/release/bundle/deb/Auffi_X.Y.Z_amd64.deb \
  sharer/src-tauri/target/release/bundle/rpm/Auffi-X.Y.Z-1.x86_64.rpm \
  sharer/src-tauri/target/release/bundle/appimage/Auffi_X.Y.Z_amd64.AppImage
# 4) Bump filenames in viewer/public/download/index.html + the
#    KNOWN_ASSETS-Set in backend/src/downloads/handlers.ts
# 5) ./ops/deploy.sh --yes
# Windows-Builds passieren auf einer separaten Windows-Box (siehe das
# offene "Windows vX.Y.Z build (sharer)"-GH-Issue-Template).
#
# IMPORTANT — Mixed-platform-release-Gotcha:
# Sobald vX.Y.Z released ist, zeigt /releases/latest/download/... auf
# die NEUE Tag. Solange Windows-Assets noch nicht hochgeladen sind
# (Windows-Build pending), wuerden die 3 Windows-Download-Buttons auf
# /download/ als 404 antworten. Workaround: in viewer/public/download/
# index.html die 3 Windows-hrefs temporaer auf
#   /releases/download/v<PREVIOUS>/...
# explizit pinnen (statt /releases/latest/download/...). Sobald
# Windows-Sync-Commit landet: wieder auf /latest/ zurueckstellen.
# Beispiel: Commit f34a445 (pin auf v0.4.1) + 5be400b (zurueck auf
# latest fuer v0.4.2).

# Admin-Promote auf prod — sqlite3-Binary ist NICHT im backend-Image,
# also via Node + better-sqlite3 (ist schon installiert) auf der DB
# unter /var/lib/auffi/auffi.db. SQLite-WAL ist sicher fuer einen
# einzelnen Live-Writer, der UPDATE ist atomic; Backend muss NICHT
# gestoppt werden.
ssh musikersuche@musikersuche.org 'docker exec auffi-backend node -e "
const Database = require(\"better-sqlite3\");
const db = new Database(\"/var/lib/auffi/auffi.db\");
const before = db.prepare(\"SELECT id, email, admin FROM accounts WHERE email = ?\").get(\"EMAIL_HIER\");
console.log(\"before:\", JSON.stringify(before));
db.prepare(\"UPDATE accounts SET admin = 1 WHERE email = ?\").run(\"EMAIL_HIER\");
const after = db.prepare(\"SELECT id, email, admin FROM accounts WHERE email = ?\").get(\"EMAIL_HIER\");
console.log(\"after :\", JSON.stringify(after));"'
```

## Rebrand Naming Inconsistencies (Intentional)

The project was rebranded from Screenie to Auffi in 2026-05. Most identifiers are now `auffi*`, but a few keep the old `screenie*` name to preserve persistent state on the production host. **Do not change these without a migration plan:**

- Server path `/opt/screenie` — kept; renaming would require stopping the stack and `mv`-ing the directory.
- Docker Compose project name on prod = `screenie` (auto-derived from `/opt/screenie`). Volume prefixes are `screenie_*` (e.g. `screenie_caddy-data`, `screenie_viewer-static`). Renaming would break Let's Encrypt cert persistence and trigger new-volume creation.
- `/var/log/screenie-health.log` cron-example path — existing cron entries continue logging to the same file.

Container names (`auffi-backend`, `auffi-caddy`, `auffi-coturn`, etc.), image names, env-var names (`AUFFI_BACKEND_WS` etc.), and TURN realm (`turn.auffi.app`) all use the new branding.

## Non-Negotiable Engineering Rules

### Cleanliness

- **No `as any` casts** and no reaching into private members of other modules. If you need access, expose a public method.
- **No TODO / FIXME comments** deferring work. Either do it now or open a tracked issue.
- **No dead code** — unused functions, parameters, imports get removed.
- **No comments restating WHAT the code does.** Comments only for non-obvious WHY (hidden invariant, workaround for a bug).
- **No quick fixes or hacks.** If something is hard to do right, do it right anyway. If you genuinely cannot, surface it and ask.
- **Errors get handled at module boundaries**, not validated everywhere internally. Trust framework guarantees.

### Library Versions

- **Use latest stable** of every direct dependency at time of install. Verify with `npm view <pkg> version`, `cargo search <crate>`, etc.
- Plans may list specific version numbers — treat them as **minimum-major-pin guidance**. Always bump to current stable patch + minor. Match the major version unless there's a documented reason to upgrade.
- After install, **pin to exact versions in package.json / Cargo.toml** (no `^` or `~`). Reproducible builds matter.

### Testing

- **TDD is mandatory**: write failing test → see it fail → minimal implementation → see test pass → commit.
- **Coverage target: ≥ 70 %** statement coverage per package. Verify with `npm test -- --coverage` (Vitest), `cargo tarpaulin` (Rust).
- **No mocked databases** when integration-testing — use real services via Docker.
- **E2E tests** for user-facing flows (Playwright for the viewer).

### Commits

- Conventional Commits format: `feat(scope): subject`, `fix(scope): subject`, `chore(scope): subject`, `docs(scope): subject`, `test(scope): subject`.
- Each commit is atomic — one logical change, all tests pass.
- Commit message body explains WHY when non-obvious.

### Security & DSGVO

- **No logging of PII**: no IPs in plain text in logs (use truncated `84.xxx`), no user content, no session content.
- **Code TTL enforced server-side**, not just client-side. 10 minutes hard cap.
- **All persisted state must have a retention policy.** In-memory state is fine; if you add a DB later, document retention.
- **No third-party trackers** in the viewer. No analytics SDKs, no Google Fonts CDN, no external CSS. Self-host everything. *Exception:* a self-hosted Matomo on the same VPS (`musikersuche.org/matomo/`, Site ID 6), folgendermaßen aufgebaut:
  - **Frontend-Opt-in via Consent-Banner** (`viewer/public/matomo-consent.{js,css}` since DSGVO-Review 2026-05-21). Pure vanilla JS, von den 4 statischen Marketing-HTMLs (`viewer/index.html`, `impressum/`, `datenschutz/`, `download/`) extern geladen; Matomo's `matomo.js` wird ERST nach „Statistik OK"-Klick injiziert. `navigator.doNotTrack === "1"` → Banner erscheint gar nicht erst. Entscheidungs-Tabelle (consent × DNT → load/banner/skip) ist isoliert in `viewer/src/matomo-consent-decision.ts` + 10 Vitest-Cases; die Vanilla-JS-Datei dupliziert die 4 Logik-Zeilen, damit sie ohne Vite-Bundling auf den statischen Legal-Pages läuft.
  - **Matomo-Verhalten nach dem Opt-in**: cookieless (`_paq.push(['disableCookies'])`), DNT-respekted (`setDoNotTrack=true`), kein `enableLinkTracking`, IP wird auf Matomo-Seite anonymisiert. Disclosure: `viewer/public/datenschutz/index.html` §9 (opt-in-banner + cookieless-mention) + §9a (Download-Counter, jetzt server-side via Stream-Proxy).
  - **Backend-side Code-Mint-Tracking** parallel zum Frontend: bei jedem geminteten Code feuern wir (a) einen server-side `e_c=session&e_a=code_created`-POST via `backend/src/tracking/matomo.ts` (ENV-gated `MATOMO_TRACKER_URL` + `MATOMO_SITE_ID`; absent env = silent no-op, no `cip`/`uid`/`url`/`urlref` jemals gesendet), und (b) eine reine Timestamp-Row in `code_events` via `backend/src/tracking/code_events.ts` als verlässliche lokale Single-Source-of-Truth (Retention 365 d via `purge.ts`, abfragbar über `/api/admin/stats/codes`). Frontend-Banner-Opt-out berührt keinen der beiden Backend-Sinks — die Code-Mint-Statistik ist anonym & aggregiert (Art. 6(1)(f), in Datenschutz §9 disclosed).
  - **Historic context**: Pattern oszillierte gh #96 → externe → fecd506-era back-to-inline → 2026-05-21 wieder extern + Consent-Banner. Auslöser fürs letzte Refactor: cookieless allein erfüllt die strikte §25-TTDSG-Auslegung des LfDI Niedersachsen nicht — Opt-in zwingend. Matomos „tracking-code-validator"-UI findet die externe Variante via HEAD-curl nicht mehr (sie sucht Inline-Snippets); Tracking-POSTs gehen unbeeinflusst durch, nur Matomo's Setup-Detection-Heuristik klemmt. CSP-Hashes im `caddy/Caddyfile` sind nur noch zwei (die zwei JSON-LD-Inline-Blöcke); der dritte (Inline-Matomo) ist seit dem Refactor weg.
- **TLS everywhere in production.** No HTTP, no WS. Let's Encrypt via reverse proxy.
- **Sharer confirmation is mandatory** — never auto-accept incoming peer connections.
- **WebRTC must use DTLS-SRTP** (default). Don't disable it.
- **TURN credentials are ephemeral** (HMAC-based, expire in ≤ 1 h). No long-lived shared secrets in client code.

### Architecture

- Each component has **one clear responsibility**. Files small and focused.
- **Cross-component contracts** (signaling messages, REST endpoints) are documented in `docs/protocol.md`. Both sides reference the same spec.
- **Backend is stateless across restarts where possible.** In-memory session state is acceptable for MVP, but the design must accommodate horizontal scaling later (e.g., Redis-backed store as a drop-in).
- **No shared mutable state across module boundaries.** Pass dependencies in.

### Sharer Debug Logging

`println!` / `eprintln!` from inside Tauri command handlers are **swallowed by `tauri-cli` pipe buffering** — you will see nothing on stdout. Use the `dbg_log()` helper in `sharer/src-tauri/src/lib.rs` instead; it appends to `auffi-debug.log` in the OS temp dir (`/tmp/auffi-debug.log` on Linux/macOS, `%TEMP%\auffi-debug.log` on Windows) with an explicit flush. Tail that file while running `tauri:dev`.

### WebRTC Connectivity Footguns

Three load-bearing settings that took the 2026-05-13 connectivity chain to find. Don't undo them without a stronger reason than "the defaults look fine."

- **`MulticastDnsMode::QueryAndGather` on the sharer's `SettingEngine`** (`sharer/src-tauri/src/webrtc_peer.rs`). The webrtc-rs default is `QueryOnly` — accepts inbound mDNS but emits raw private IPs of every interface. Chrome's viewer publishes ONLY `.local` mDNS hostnames; with raw-IP-vs-mDNS the candidate pairs never match and ICE silently falls back to TURN relay, even on the same LAN. `QueryAndGather` makes the sharer also publish `.local` names; avahi/Bonjour on the host bridges them. Bonus: stops leaking the 25 Docker-bridge IPs in SDP.
- **coturn `listening-ip` + `external-ip` pinned to the public IPv4** (`coturn/turnserver.conf.tmpl`, env-driven from `TURN_LISTENING_IP`/`TURN_EXTERNAL_IP`). The IONOS VPS binds its public IPv4 `/32` to `ens6` but coturn's libc-interface autodetect skipped it. Auto-detect is only safe on home-server topologies. On cloud deployments always pin both env vars in `.env.prod`.
- **rAF-throttle for `pointermove`** (`viewer/src/input-capture.ts`). A 1000 Hz gaming mouse generates 17× more events than the display can render; the unreliable input DataChannel + sharer's enigo apply-loop becomes the bottleneck and the cursor visibly lags. `requestAnimationFrame` coalescing brings the rate down to ~60 Hz with only the latest x/y per frame. Buttons/keys/wheel stay immediate.

UFW on the prod host is configured to allow `3478/tcp`, `3478/udp`, `5349/tcp`, `5349/udp`, and `49152-65535/udp` (TURN relay-port range). This isn't tracked in the repo — UFW state is host-local. If a fresh host gets provisioned, replay the `ufw allow …` commands listed in `docs/postmortem-2026-05-13-connectivity.md`.

**TURN auf TCP 443 — dokumentierter Gap (#90 closed 2026-05-22).** Manche Corporate-Firewalls erlauben nur outbound 80 + 443. coturn auf `5349/tcp` ist dort blockiert → Verbindung scheitert mangels Relay. Tailscale + Jitsi laufen aus dem Grund auf `:443`. Wir tun das **nicht**, weil:
- `443/tcp` gehört dem Cluster-Caddy (shared mit anderen Tenants — kein unilateraler Eingriff möglich)
- SNI-Routing via Caddy-`layer4` braucht Custom-Caddy-Build oder haproxy-Sidecar — substantial infra
- Eine zweite öffentliche IPv4 auf der IONOS-VPS kostet extra + bedient nur Edge-Case-User
Mitigation für die betroffene User-Gruppe: Tailscale/WireGuard-Overlay vorschlagen ODER #93 (direct-connect-mode für Power-User mit bekannter IP) abwarten. Bei sehr hohem Corporate-Bedarf re-evaluieren — dann am ehesten haproxy-l4 als Sidecar.

### Sharer Teardown Has Multiple Intents

`disconnect_streaming` looks like one function but is called from three distinct intents and each wants a different subset of state torn down:

1. **End the session** (user clicked Beenden, or bootstrap on F5) — drop everything including `SignalingState`.
2. **Swap viewers on the same code** (new `peer-joined` arrived while the previous viewer is gone) — keep `SignalingState` (the WS task that just delivered the `peer-joined` is the same one the next `confirm_peer` / `receive_offer` will go through), drop the rest.
3. **Re-bootstrap after webview F5** — full teardown so `start_signaling` doesn't trip the `#64` guard.

Today this is gated by an optional `keep_signaling: bool` parameter. If you refactor in this area, audit which lifetimes each caller wants to end before changing behaviour. See `docs/postmortem-2026-05-12-monitor-switch.md` for the bug chain that led to the current shape.

Plasma's `org.freedesktop.portal.ScreenCast` will **not** surface a second dialog while the first source is alive, and routes media unpredictably if two GStreamer/portal pipelines overlap. Tear down the previous `streaming_loop` (and its capturer) before starting a new one — the mpsc switch-channel's close is the canonical shutdown signal for the loop.

### Unattended-Access Footguns

Five load-bearing facts that took the 2026-05-13 deep review (and the M-1/M-2/TC C-2 follow-ups on 2026-05-14) to find:

- **Session cookie is `__Host-auffi_session`, not `auffi_session`** (Sec L-1, `backend/src/auth/sessions.ts`). The `__Host-` prefix is enforced by the browser: cookie MUST have `Secure`, `Path=/`, and NO `Domain` attribute. Subdomains of `auffi.app` cannot forge or overwrite the cookie. Anywhere a test or doc hard-codes the cookie name, it needs the prefix.
- **`pending_confirms` is a `HashMap<u64, Sender>`, not an `Option<Sender>`** (Sec M-1/M-2, `sharer/src-tauri/src/unattended_cmd.rs`). Each manual-confirm pw-check gets its own monotonic `confirm_id`; the spawned waiter task awaits its own oneshot and replies independently so the forwarder loop is never blocked. The frontend MUST echo `confirmId` from the `needs-confirm` event back through `unattended_confirm` — a click without an id is a silent no-op.
- **Late `pw-check-result` is silently dropped, not error-reported** (TC C-2, `backend/src/signaling.ts`). A sharer that took a long manual-confirm path can land its result after the viewer gave up. Sending a `bad-message` error here would force the sharer's heartbeat to reconnect (it treats backend-errors as fatal disconnects). Anyone DRY-ing protocol-violation handling MUST keep this branch silent.
- **Account password gate uses argon2id with `m=64 MiB, t=3, p=1`** (`backend/src/auth/argon.ts`). The sharer's local password hashing in `device_password.rs` mirrors the same params so dashboard-set passwords and CLI-set passwords are wire-compatible. Don't tune one side without the other.
- **`auth_rate_limit`, `register_rate_limit`, AND `bearer_auth_rate_limit` are three different env-driven caps**. Tests that open many WSS connections from `127.0.0.1` need to set `BEARER_AUTH_RATE_LIMIT_MAX=1000` alongside `REGISTER_RATE_LIMIT_MAX=1000` (Sec H-1). The bearer cap protects argon2-DoS on `/signal`'s upgrade headers.

### AppImage-Build Footguns

Tauri's AppImage-Bundling scheitert zuverlässig auf modernen Arch-Installs aus zwei Gründen — der Wrapper `ops/build-sharer-appimage.sh` umschifft beide. Wer ihn ignoriert und nur `npm run tauri:build` aufruft, bekommt `.deb` und `.rpm`, aber keinen AppImage:

- **`linuxdeploy`'s eingebautes `strip` versteht `.relr.dyn` nicht** (DT_RELR aus modernem binutils). Stirbt an `libxkbcommon`, `libxml2`, `libxslt`, `libyuv`, `libzstd`. Opt-out: `NO_STRIP=1` als env var an den Tauri-Build-Call.
- **Tauri legt das Icon unter `Auffi.AppDir/usr/share/icons/hicolor/.../auffi-sharer.png` ab, appimagetool sucht es als `Auffi.AppDir/auffi-sharer.png`** (neben der `.desktop`). Workaround: vor der finalen Bundle-Stufe `cp` ans Root.

Beide Workarounds sind im Wrapper-Skript automatisiert (`./ops/build-sharer-appimage.sh`, oder `--finish` für schnelle Iteration auf einem bestehenden AppDir). Bei neuen Tauri- oder linuxdeploy-Releases re-evaluieren — beide Bugs könnten dann obsolet sein.

Hängt unmittelbar von `fuse2` auf dem Build-Host ab (Arch: `sudo pacman -S fuse2`). Ohne libfuse2 startet linuxdeploy als AppImage gar nicht.

### Download-Proxy Patterns

Seit dem DSGVO-Review 2026-05-21 laufen alle Sharer-Downloads stream-through über den Backend statt direkt zu GitHub zu redirecten — kostet uns ein bisschen VPS-Bandbreite, dafür landen alle Download-URLs auf `auffi.app` und der per-Asset-Counter bleibt zuverlässig server-side. Vier Architektur-Entscheidungen, die nicht trivial sind:

- **Counter wird beim Stream-Start gebumpt, nicht beim Klick.** Vorher: Client-JS feuerte einen separaten `POST /api/downloads/:asset` per `sendBeacon`, dann ließ es den Browser zu GitHub redirecten. Heute: `GET /api/downloads/file/:asset` macht beides — fetcht das Asset upstream, bumpt den Counter NUR wenn upstream OK ist, streamt den Body durch. `backend/src/downloads/handlers.ts`.
- **`?tag=vX.Y.Z`-Whitelist für Asset-Pinning.** Optional, default ist `/releases/latest/download/`. Wenn Linux-v0.4.5 released ist aber Windows noch auf v0.4.4 hängt, würden Windows-Downloads `latest`-redirecten auf v0.4.5 → 404 (Asset nicht im neuen Release). Workaround: Windows-Hrefs auf `?tag=v0.4.4` pinnen bis der Windows-Build nachzieht. Regex `/^v\d+\.\d+\.\d+$/` verhindert Pfad-Injection.
- **HEAD short-circuit überspringt Counter + Upstream-Fetch.** Link-Preview-Crawler + Uptime-Monitoring würden den Counter sonst inflate UND pro Probe-Request den ganzen 200 MB-Stream durch unsere Pipe ziehen. Auf HEAD: 200 + Content-Disposition-Header zurück, kein DB-Schreiben, kein GH-Hit. Tests in `backend/tests/downloads.test.ts` pinnen das (drei Cases: no-upstream-call, no-counter-bump, headers korrekt).
- **Content-Type immer `application/octet-stream` (Force-override) + explizit `X-Content-Type-Options: nosniff`** — MIME-Confusion-Defence. Falls GitHubs S3-CDN je einen 2xx mit `text/html`-Body liefert (Edge-Case bei CDN-Fehlern), würde Upstream-Forward den Browser ein HTML rendern lassen statt Download-Pfad zu triggern. `caddy/Caddyfile` setzt `nosniff` ohnehin global; doppelt hält besser und macht den Schutz auf der Route sichtbar.

Failure-Modi: Upstream-Status nicht 2xx **oder** Upstream-Body fehlt → 502 + kein Counter. Upstream-2xx + Body **vorhanden** → 200, Counter bump, Stream durch.

### Admin-Section Patterns

Drei zusammenhängende Konventionen für Admin-only-UI im Dashboard, gh #53/#54. Backend bleibt mit `requireAdmin`-preHandler auf jeder `/api/admin/*`-Route die echte Grenze — diese Patterns sind reines UX:

- **Route-Gate via `adminOnly: true` + Router-Substitution.** `dashboard/src/router.ts`'s `createRouter` akzeptiert `{ isAdmin: () => boolean, renderAdminForbidden: RouteRenderer }`. Routes mit `adminOnly: true` werden in `buildNav()` via `visibleRoutes()` (in `admin-nav.ts`) für non-Admins ausgefiltert. Direct-URL-Zugriff auf eine adminOnly-Route ohne Admin substituiert der Router den `renderAdmin403`-View statt der eigentlichen Renderer-Funktion. Single „Admin"-Entry oben in der Topbar → `/admin` overview-Page; Sub-Pages (`/admin/users`, `/admin/stats`, `/admin/feedback`) sind nur via Quick-Nav von /admin aus oder über Direct-URL erreichbar.
- **Active-Nav-Highlight via `dashboard:rendered`-CustomEvent.** Router dispatched nach jedem `render()` ein `dashboard:rendered`-CustomEvent auf `window` (mit `detail: { path }`). `main.ts` lauscht → `updateActiveNav()` setzt `.active` + `aria-current="page"` auf den Nav-Link, dessen `href` der aktuellen `location.pathname` entspricht. Erspart Tight-Coupling Router → Nav-Modul; jedes andere Nav-adjacent-Modul kann sich an dasselbe Event hängen ohne Router-Änderung.
- **Reusable Confirm-mit-Reason-Modal.** `dashboard/src/components/confirm-with-reason.ts` → `Promise<string|null>` (resolved zur Reason auf Confirm, zu `null` auf Cancel/Escape/Backdrop-Click). Single-DOM-Slot (`#admin-modal-backdrop`; vorherige Instanzen werden vor Open abgeräumt), Reason ≥ 10 Zeichen (trim-aware, isolierter `reasonIsValid()`-Helper, 8 Vitest-Cases). Confirm-Button bleibt disabled bis Reason valid. Pflicht-Pattern für ALLE destruktiven Admin-Aktionen (Suspend, Promote, Demote, Delete). Backend's eigene Reason-Validation ist asymmetrisch: `PATCH /api/admin/users/:id` toleriert leeren reason, `DELETE` erzwingt non-empty — die Client-Min-10-Char-Schwelle ist strenger als beide, was OK ist (UX-Defence).

`/api/me.admin: boolean` ist seit 2026-05-22 die einzige Quelle für die client-side-isAdmin-Entscheidung. Anonymous-User (401) und Network-Errors collapsen beide zu `isAdmin=false` (UX-safe default). Sessions vor dem Bump können das Feld fehlend haben — TypeScript-Client behandelt `undefined` korrekt als false. Backend's `requireAdmin` ist davon unabhängig (liest `account.admin` direkt aus DB pro Request).

### Caddyfile Footguns

- **Never blanket-block `bot`/`crawler`/`spider` as User-Agent substrings**. The original auffi.app site had `@scrapers { header_regexp User-Agent (?i)(scrapy|bot|crawler|spider|…) }` which matched every legit search-engine crawler (`Googlebot`, `bingbot`, `DuckDuckBot`, `AhrefsBot`, `LinkedInBot`, `Twitterbot`, `facebookexternalhit`…) and returned 403. Search Console couldn't fetch the sitemap; SEO outage from 2026-05-12 to 2026-05-14. The narrow allow-list lives in `caddy/Caddyfile`: scrapy, wget, curl, headlesschrome, phantomjs, nikto, sqlmap, sqlninja, nmap, masscan, metasploit, dirbuster, nuclei, wpscan. The cluster Caddyfile at `/opt/caddyserver/Caddyfile` carries the same fix — keep both in sync when adding new bad-actor signatures.
- **Caddy v2 subroute matches routes in declaration order, NOT by matcher specificity** (despite docs hinting otherwise). When a `path_regexp` matcher and a `path` matcher could both match, whichever was textually first wins. Concrete bite: `import dotfile_protection` (which expands to `path_regexp \/\.`) was placed at the top of the auffi.app block, and a later `handle /.well-known/* { reverse_proxy auffi-viewer:80 }` never fired — `/.well-known/security.txt` 403'd. Fix is positional: the `/.well-known/*` handle MUST be inserted BEFORE `import dotfile_protection`.
- **`import security_headers` + later `header X-Frame-Options DENY` does NOT override the imported value** (SEC-M1, 2026-05-17). The shared cluster `security_headers` snippet sets `X-Frame-Options "SAMEORIGIN"` + `Referrer-Policy "strict-origin-when-cross-origin"`; the per-tenant `header X-Frame-Options DENY` line below was silently ignored — live response carried SAMEORIGIN. Tried `>`/`?`/`+` prefixes, a separate delete-then-set block (`header -X-Frame-Options; X-Frame-Options DENY`) — none of them overrode. The only working fix was to NOT import `security_headers` in the auffi.app block at all and inline every header (Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, -Server) with the auffi-specific values. Likely Caddy applies the imported `header {}` block in a later phase than the inline one — quirky semantics around `header { ... }` directives that span both snippet-imports and inline blocks. **Pattern for any future per-tenant header override**: drop the import, write everything inline.
- **Four cluster-only Caddyfile patches** that don't live in the repo because the cluster Caddyfile is shared with other tenants: (1) `/api/* → auffi-backend:8080`, (2) `/dashboard/* → auffi-dashboard:80` + `redir /dashboard /dashboard/ permanent`, (3) `/.well-known/* → auffi-viewer:80` placed BEFORE dotfile_protection. Plus the scrapers-regex narrowing. **(4)** Matomo CSP: append `https://musikersuche.org` to `script-src` AND `connect-src` of the `auffi.app {}` block. **No inline-Matomo-hash needed since the 2026-05-21 Consent-Banner-Refactor** — Matomo lädt jetzt via externes `/matomo-consent.js` (covered by `'self'`), die zwei verbleibenden CSP-sha256-Hashes whitelisten nur die zwei JSON-LD-Inline-Blöcke. Der alte dritte Hash `sha256-zrNDhMThszjoh7hKKym112SwQTRucbjaJn81UYoRyow=` darf aus dem cluster-Caddyfile entfernt werden (in-repo bereits raus) — wenn er drin bleibt, ist es harmlos. In-repo `caddy/Caddyfile` carries the full set; the cluster file at `/opt/caddyserver/Caddyfile` needs the same patches by hand. If a fresh cluster host gets provisioned, replay the patches in `/tmp/patch_cluster_*.py` (the scripts are kept in `/tmp` on the dev box, not in the repo — same posture as the UFW rules).

### Matomo Cross-Tenant Trust

Die selbst-gehostete Matomo-Instanz auf `musikersuche.org/matomo/` ist eine **separate Anwendung auf demselben VPS**, die unabhängig administriert wird. Konsequenz:

- **Kompromittierung von `musikersuche.org` = Kompromittierung der Auffi-Marketing-Pages** (XSS-equivalent via die `<script src="//musikersuche.org/matomo/matomo.js">`-Injection im Matomo-Snippet). Ein logged-in User auf auffi.app/ würde dann sein `__Host-auffi_session`-Cookie an einen kontrollierten Endpoint leaken (das FAB probet aktiv `/api/me`).
- **SRI-Pin nicht möglich** weil Matomo seine matomo.js in-place updatet. Acceptable Risk solange wir musikersuche.org selbst administrieren, aber wenn dort jemals ein Dritt-Tenant hinzukommt → harte Mitigation nötig (SRI mit Versions-gepinntem matomo.js, oder Matomo-API durch unseren Backend reverse-proxyen).
- **DNS-Pin nicht codiert**: wenn `musikersuche.org` jemals den Host wechselt (z.B. CDN), wird daraus ein nicht-disclosed Drittland-Transfer. A-Record sollte stabil zur DE-IP zeigen — wenn ich es jemals ändere, MUSS ich die Datenschutzerklärung §9 + diesen CLAUDE.md-Eintrag aktualisieren UND die script-src in Caddyfile re-evaluieren. Aktuell `musikersuche.org` → IONOS Frankfurt (DE).

(Security-Review SEC-M3 + DSGVO-M5, 2026-05-17.)

### Cluster-Ops Footguns

Three things that took today's (2026-05-17) Matomo + Feedback deploys to find. They're cluster-deployment-only (don't apply to a standalone-mode `docker-compose.prod.yml` host):

- **Cluster reverse-proxy is `caddy-proxy`** (image `caddy-custom:2.11.2-ratelimit`), NOT `auffi-caddy`. The latter only exists in standalone mode. `docker exec auffi-caddy …` will fail with "No such container" on cluster hosts. Use `docker exec caddy-proxy …` instead. The Caddyfile path is `/opt/caddyserver/Caddyfile` on the host (bind-mounted into the container).
- **Cluster Caddyfile has `admin off`** (line 6), so `docker exec caddy-proxy caddy reload --config /etc/caddy/Caddyfile` fails with `connect: connection refused` on the admin-API port 2019. The only reload path is `docker restart caddy-proxy` (~3 s connection blip — acceptable for a tenant-shared host but document the blip if you're scheduling it). Always `docker exec caddy-proxy caddy validate --config /etc/caddy/Caddyfile` BEFORE the restart so a syntax error doesn't take auffi.app offline.
- **`docker compose restart backend` does NOT re-read `.env.prod`.** `restart` recycles the existing container with its existing env-snapshot from start-time. New env-vars (e.g. adding `SMTP_FROM=…` or `MATOMO_*`) require `docker compose -f docker-compose.prod.yml -f docker-compose.cluster.yml --env-file .env.prod up -d --force-recreate --no-deps backend`. The deploy script does the right thing on full deploys; only manual env tweaks have this trap.

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

## Daily Backup

Cron-Job auf prod (installiert 2026-05-18): `15 4 * * * /opt/screenie/ops/backup.sh >> /opt/backup/auffi/backup.log 2>&1`. Script-Quelle im Repo: `ops/backup.sh`. Wird bei jedem `./ops/deploy.sh` automatisch nach `/opt/screenie/ops/backup.sh` gerollt (separate `maybe_run`-Schritte). Für Ad-hoc-Runs ohne Deploy: `./ops/maintenance.sh backup`. Das Backup-Log liegt nur auf prod (`/opt/backup/auffi/backup.log`) — bei starkem Wachstum mit `logrotate` aufräumen.

**Was gesichert wird, jede Nacht 04:15:**
- `/var/lib/auffi/auffi.db` — konsistenter Snapshot via `better-sqlite3 .backup()` (Online-Backup-API, kein Backend-Stop nötig, WAL-Inhalt wird mit eingerechnet). Output: `auffi-db_YYYY-MM-DD_HHMMSS.db.gz`.
- Cluster-Caddy-Volumes `caddyserver_caddy_data` + `caddyserver_caddy_config` (Let's-Encrypt-Account + ausgestellte TLS-Certs für auffi.app, www.auffi.app, turn.auffi.app — UND Certs anderer Cluster-Tenants, weil das Volume shared ist). Output: `auffi-caddy_YYYY-MM-DD_HHMMSS.tar.gz`. **Wichtig:** im Cluster-Modus liegen die echten LE-Certs hier, NICHT im `screenie_caddy-data`-Volume — das ist im Cluster-Setup tot (siehe "Cluster-Ops Footguns" oben).

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
# cluster-shared, siehe Cluster-Ops Footguns):
docker restart caddy-proxy
rm -rf /tmp/caddy-restore
```

Optionaler off-site Sync via `BACKUP_REMOTE_TARGET=user@host:/backups/auffi/` env-var (rsync, im Script bereits eingebaut, aktuell nicht gesetzt). User stellt den SSH-Key out-of-band bereit — kein Key im Repo.

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

**Rollback** (`./ops/deploy.sh --rollback`): liest vorletzten SHA aus Deploy-Log, prüft dass dessen Image noch da ist, setzt `APP_VERSION` in `.env.prod` um, retagged `:latest`, `compose up -d`, Health-Check. Voraussetzung: das alte Image war noch nicht vom Prune erwischt — also nutzbar für die letzten 3 Deploys.

**Wenn ein Restart-Trigger fehlt**: Service-Restart-Liste in Schritt 9 ist allowlist-basiert. Wenn ein NEUER bind-mounteter File-Pfad hinzukommt, der einen Container-Restart braucht (zB ein neuer `nginx/something.conf`), MUSS er in Schritt 9 in `deploy.sh` ergänzt werden. Sonst landet die neue Config zwar via rsync auf prod, der Container bleibt aber an der alten Inode hängen.

## Definition of "Done" per Task

A task is done when **all** of these hold:

1. All tests pass: `npm test`, `cargo test`, etc. (Baseline at 2026-05-22: backend 386, sharer-lib 188 (+ 6 `#[ignore]` Display-requiring), viewer 191, dashboard 114. Drops are regressions. Run sharer's display-requiring tests via `cd sharer/src-tauri && cargo test --lib -- --ignored` on a host with X11/Wayland.)
2. Coverage ≥ 70 % for new code.
3. Lint passes: `eslint`, `cargo clippy -- -D warnings`.
4. Type check passes: `tsc --noEmit`, `cargo check`.
5. Code committed atomically with Conventional Commit message.
6. No new TODO / FIXME / `as any` / dead code introduced.
7. If task touched UI: manual smoke-tested.
