# Footguns & Load-Bearing Settings

Deep-dive reference for the non-obvious settings, teardown intents, and build/proxy quirks that took real incident chains to discover. Don't undo any of these without a stronger reason than "the defaults look fine." Referenced from `CLAUDE.md`.

## WebRTC Connectivity Footguns

Three load-bearing settings that took the 2026-05-13 connectivity chain to find. Don't undo them without a stronger reason than "the defaults look fine."

- **`MulticastDnsMode::QueryAndGather` on the sharer's `SettingEngine`** (`sharer/src-tauri/src/webrtc_peer.rs`). The webrtc-rs default is `QueryOnly` — accepts inbound mDNS but emits raw private IPs of every interface. Chrome's viewer publishes ONLY `.local` mDNS hostnames; with raw-IP-vs-mDNS the candidate pairs never match and ICE silently falls back to TURN relay, even on the same LAN. `QueryAndGather` makes the sharer also publish `.local` names; avahi/Bonjour on the host bridges them. Bonus: stops leaking the 25 Docker-bridge IPs in SDP.
- **coturn `listening-ip` + `external-ip` pinned to the public IPv4** (`coturn/turnserver.conf.tmpl`, env-driven from `TURN_LISTENING_IP`/`TURN_EXTERNAL_IP`). The IONOS VPS binds its public IPv4 `/32` to `ens6` but coturn's libc-interface autodetect skipped it. Auto-detect is only safe on home-server topologies. On cloud deployments always pin both env vars in `.env.prod`.
- **coturn `denied-peer-ip` SSRF deny-list** (`coturn/turnserver.conf.tmpl`). coturn relays to any unicast peer by default; with `network_mode: host` that's an open relay to the VPS's internal/loopback/metadata addresses. The config denies every special-use/private IPv4+IPv6 range (incl. IPv4-mapped `::ffff:`); legit WebRTC peers are public NAT-reflexive addresses, so sessions (incl. same-LAN) are unaffected. NB: `no-loopback-peers` is a no-op on the deployed coturn 4.6.3 ("Bad configuration format" in the log) — loopback is actually covered by the explicit `127.0.0.0/8` + `::1` ranges; the line is harmless belt-and-suspenders. Verify after a coturn restart by grepping the log for `Black listing:` (one line per range).
- **`denied-peer-ip=::` is match-ALL — NEVER set it** (`coturn/turnserver.conf.tmpl`; root cause of the relay outage fixed in `d4c61af`). coturn 4.6.3 parses the unspecified address `::` as *match every peer*, so a bare `denied-peer-ip=::` denies **all** relay peers including public IPs. Symptom: P2P/LAN keeps working (it bypasses coturn) but every relay-dependent remote session dies, with `A peer IP <public> denied in the range: ::` in the log. coturn's per-family matching is the trap: a **native-v4** peer is only checked against **plain-v4** `denied-peer-ip` ranges, while a **mapped-form** peer (`::ffff:a.b.c.d`) is only checked against **v6** ranges — so SSRF defense needs *both* the plain-v4 ranges **and** the `::ffff:0.0.0.0-::ffff:255.255.255.255` blanket (that blanket only hits mapped-form private peers, never public ones, so it was never the outage). After any coturn-config change, test against `coturn/coturn:4.6.3-alpine` with `turnutils_uclient` (CreatePermission): a public peer must be ALLOWED, a private *and* a mapped-private peer DENIED — "ranges loaded in the log" is not proof.
- **rAF-throttle for `pointermove`** (`viewer/src/input-capture.ts`). A 1000 Hz gaming mouse generates 17× more events than the display can render; on the (ordered, reliable) input DataChannel every one of them queues behind its predecessors, the sharer's enigo apply-loop becomes the bottleneck and the cursor visibly lags. `requestAnimationFrame` coalescing brings the rate down to ~60 Hz with only the latest x/y per frame. Buttons/keys/wheel stay immediate. Reliability is NOT the knob to turn here: the channel is deliberately `ordered: true` without `maxRetransmits`, because a dropped key-up/button-up leaves a stuck key on the sharer (gh #97) — the rAF coalescing is what keeps the reliable queue short.

UFW on the prod host is configured to allow `3478/tcp`, `3478/udp`, `5349/tcp`, `5349/udp`, and `49152-65535/udp` (TURN relay-port range). This isn't tracked in the repo — UFW state is host-local. If a fresh host gets provisioned, replay the `ufw allow …` commands listed in `docs/postmortem-2026-05-13-connectivity.md`.

**TURN auf TCP 443 — dokumentierter Gap (#90 closed 2026-05-22).** Manche Corporate-Firewalls erlauben nur outbound 80 + 443. coturn auf `5349/tcp` ist dort blockiert → Verbindung scheitert mangels Relay. Tailscale + Jitsi laufen aus dem Grund auf `:443`. Wir tun das **nicht**, weil:
- `443/tcp` gehört dem Cluster-Caddy (shared mit anderen Tenants — kein unilateraler Eingriff möglich)
- SNI-Routing via Caddy-`layer4` braucht Custom-Caddy-Build oder haproxy-Sidecar — substantial infra
- Eine zweite öffentliche IPv4 auf der IONOS-VPS kostet extra + bedient nur Edge-Case-User
Mitigation für die betroffene User-Gruppe: Tailscale/WireGuard-Overlay vorschlagen ODER #93 (direct-connect-mode für Power-User mit bekannter IP) abwarten. Bei sehr hohem Corporate-Bedarf re-evaluieren — dann am ehesten haproxy-l4 als Sidecar.

## Sharer Teardown Has Multiple Intents

`disconnect_streaming` looks like one function but is called from three distinct intents and each wants a different subset of state torn down:

1. **End the session** (user clicked Beenden, or bootstrap on F5) — drop everything including `SignalingState`.
2. **Swap viewers on the same code** (new `peer-joined` arrived while the previous viewer is gone) — keep `SignalingState` (the WS task that just delivered the `peer-joined` is the same one the next `confirm_peer` / `receive_offer` will go through), drop the rest. The same intent serves "the helper left, this sharer stays available": a received relay `bye` and the ICE-loss teardown both pass `keepSignaling: true`, so the code stays redeemable until its TTL (`viewer-bye-policy.ts`, `ice-teardown-policy.ts`).
3. **Re-bootstrap after webview F5** — full teardown so `start_signaling` doesn't trip the `#64` guard.

Today this is gated by an optional `keep_signaling: bool` parameter. If you refactor in this area, audit which lifetimes each caller wants to end before changing behaviour. See `docs/postmortem-2026-05-12-monitor-switch.md` for the bug chain that led to the current shape.

Plasma's `org.freedesktop.portal.ScreenCast` will **not** surface a second dialog while the first source is alive, and routes media unpredictably if two GStreamer/portal pipelines overlap. Tear down the previous `streaming_loop` (and its capturer) before starting a new one — the mpsc switch-channel's close is the canonical shutdown signal for the loop.

## Unattended-Access Footguns

Five load-bearing facts that took the 2026-05-13 deep review (and the M-1/M-2/TC C-2 follow-ups on 2026-05-14) to find:

- **Session cookie is `__Host-auffi_session`, not `auffi_session`** (Sec L-1, `backend/src/auth/sessions.ts`). The `__Host-` prefix is enforced by the browser: cookie MUST have `Secure`, `Path=/`, and NO `Domain` attribute. Subdomains of `auffi.app` cannot forge or overwrite the cookie. Anywhere a test or doc hard-codes the cookie name, it needs the prefix.
- **`pending_confirms` is a `HashMap<u64, Sender>`, not an `Option<Sender>`** (Sec M-1/M-2, `sharer/src-tauri/src/unattended_cmd.rs`). Each manual-confirm pw-check gets its own monotonic `confirm_id`; the spawned waiter task awaits its own oneshot and replies independently so the forwarder loop is never blocked. The frontend MUST echo `confirmId` from the `needs-confirm` event back through `unattended_confirm` — a click without an id is a silent no-op.
- **Late `pw-check-result` is silently dropped, not error-reported** (TC C-2, `backend/src/signaling.ts`). A sharer that took a long manual-confirm path can land its result after the viewer gave up. Sending a `bad-message` error here would force the sharer's heartbeat to reconnect (it treats backend-errors as fatal disconnects). Anyone DRY-ing protocol-violation handling MUST keep this branch silent.
- **Account password gate uses argon2id with `m=64 MiB, t=3, p=1`** (`backend/src/auth/argon.ts`). The sharer's local password hashing in `device_password.rs` mirrors the same params so dashboard-set passwords and CLI-set passwords are wire-compatible. Don't tune one side without the other.
- **Four env-driven per-IP caps**: `auth_rate_limit`, `register_rate_limit`, `bearer_auth_rate_limit` (signaling `/signal` upgrade, Sec H-1), and `feedback_bearer_rate_limit` (`FEEDBACK_BEARER_RATE_LIMIT_MAX`, default 5 — gates argon2 on `POST /api/feedback`'s sharer-Bearer branch). All four share one sliding-window limiter, `checkIpRateLimit` in `backend/src/rate-limit.ts`; their bucket-Maps are swept every 60 s in `server.ts`. Tests that open many WSS connections from `127.0.0.1` need to set `BEARER_AUTH_RATE_LIMIT_MAX=1000` alongside `REGISTER_RATE_LIMIT_MAX=1000`.

## AppImage-Build Footguns

Tauri's AppImage-Bundling scheitert zuverlässig auf modernen Arch-Installs aus zwei Gründen — der Wrapper `ops/build-sharer-appimage.sh` umschifft beide. Wer ihn ignoriert und nur `npm run tauri:build` aufruft, bekommt `.deb` und `.rpm`, aber keinen AppImage:

- **`linuxdeploy`'s eingebautes `strip` versteht `.relr.dyn` nicht** (DT_RELR aus modernem binutils). Stirbt an `libxkbcommon`, `libxml2`, `libxslt`, `libyuv`, `libzstd`. Opt-out: `NO_STRIP=1` als env var an den Tauri-Build-Call.
- **Tauri legt das Icon unter `Auffi.AppDir/usr/share/icons/hicolor/.../auffi-sharer.png` ab, appimagetool sucht es als `Auffi.AppDir/auffi-sharer.png`** (neben der `.desktop`). Workaround: vor der finalen Bundle-Stufe `cp` ans Root.

Beide Workarounds sind im Wrapper-Skript automatisiert (`./ops/build-sharer-appimage.sh`, oder `--finish` für schnelle Iteration auf einem bestehenden AppDir). Bei neuen Tauri- oder linuxdeploy-Releases re-evaluieren — beide Bugs könnten dann obsolet sein.

Hängt unmittelbar von `fuse2` auf dem Build-Host ab (Arch: `sudo pacman -S fuse2`). Ohne libfuse2 startet linuxdeploy als AppImage gar nicht.

## Windows Screen Capture (WGC + GDI-Fallback)

`sharer/src-tauri/src/capture/windows.rs` nutzt primär **Windows Graphics Capture** über xcap (`Monitor::video_recorder`, feature `wgc`). Zwei Footguns, die beide zum generischen UI-Fehler „Streamen konnte nicht gestartet werden" führen:

- **WGC braucht ein COM/WinRT-Apartment auf dem aufrufenden Thread.** xcaps `video_recorder()` ruft `factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()` (→ `RoGetActivationFactory`). Ein nackter `std::thread` hat kein Apartment → `video_recorder()` scheitert mit `E_NOINTERFACE` (0x80004002) auf **jeder** Maschine. xcap initialisiert selbst keins. Fix: `ComMta::init()` (`CoInitializeEx(MTA)`) am Anfang des Capture-Worker-Threads — MTA passt zum free-threaded Frame-Pool von WGC.
- **WGC ist über RDP / auf GPU-losen Servern (z. B. Windows Server 2019) unzuverlässig.** xcaps D3D-Device ist `D3D_DRIVER_TYPE_HARDWARE`-only (kein WARP-Fallback); WGC kann initialisieren und dann nie ein Frame liefern. Deshalb: First-Frame-Probe (3 s Timeout) → bei Fehlschlag Fallback auf **GDI BitBlt** (`GdiCapture`), das über RDP und ohne GPU funktioniert. BGRA top-down, ohne Cursor (deckt sich mit WGC, das xcap cursor-los konfiguriert).

Die display-/GPU-erfordernde Integrations-Regression liegt als `#[ignore]`-Test `windows_capturer_starts_and_yields_a_frame` vor — auf einem Host mit echter Session via `cargo test --lib -- --ignored windows_capturer` laufen lassen.

## Download-Proxy Patterns

Seit dem DSGVO-Review 2026-05-21 laufen alle Sharer-Downloads stream-through über den Backend statt direkt zu GitHub zu redirecten — kostet uns ein bisschen VPS-Bandbreite, dafür landen alle Download-URLs auf `auffi.app` und der per-Asset-Counter bleibt zuverlässig server-side. Vier Architektur-Entscheidungen, die nicht trivial sind:

- **Counter wird beim Stream-Start gebumpt, nicht beim Klick.** Vorher: Client-JS feuerte einen separaten `POST /api/downloads/:asset` per `sendBeacon`, dann ließ es den Browser zu GitHub redirecten. Heute: `GET /api/downloads/file/:asset` macht beides — fetcht das Asset upstream, bumpt den Counter NUR wenn upstream OK ist, streamt den Body durch. `backend/src/downloads/handlers.ts`.
- **`?tag=vX.Y.Z`-Whitelist für Asset-Pinning.** Optional, default ist `/releases/latest/download/`. Wenn Linux-v0.4.5 released ist aber Windows noch auf v0.4.4 hängt, würden Windows-Downloads `latest`-redirecten auf v0.4.5 → 404 (Asset nicht im neuen Release). Workaround: Windows-Hrefs auf `?tag=v0.4.4` pinnen bis der Windows-Build nachzieht. Regex `/^v\d+\.\d+\.\d+$/` verhindert Pfad-Injection.
- **HEAD short-circuit überspringt Counter + Upstream-Fetch.** Link-Preview-Crawler + Uptime-Monitoring würden den Counter sonst inflate UND pro Probe-Request den ganzen 200 MB-Stream durch unsere Pipe ziehen. Auf HEAD: 200 + Content-Disposition-Header zurück, kein DB-Schreiben, kein GH-Hit. Tests in `backend/tests/downloads.test.ts` pinnen das (drei Cases: no-upstream-call, no-counter-bump, headers korrekt).
- **Content-Type immer `application/octet-stream` (Force-override) + explizit `X-Content-Type-Options: nosniff`** — MIME-Confusion-Defence. Falls GitHubs S3-CDN je einen 2xx mit `text/html`-Body liefert (Edge-Case bei CDN-Fehlern), würde Upstream-Forward den Browser ein HTML rendern lassen statt Download-Pfad zu triggern. `caddy/Caddyfile` setzt `nosniff` ohnehin global; doppelt hält besser und macht den Schutz auf der Route sichtbar.

Failure-Modi: Upstream-Status nicht 2xx **oder** Upstream-Body fehlt → 502 + kein Counter. Upstream-2xx + Body **vorhanden** → 200, Counter bump, Stream durch.

- **`/download/` ist seit dem Proxy-Refactor eine reine statische Seite** (`viewer/public/download/`), kein Binary-Verzeichnis — `nginx/auffi-viewer.conf` hat dafür keinen eigenen `location`-Block mehr (das alte `autoindex on` war eine latente Directory-Listing-Exposure). **Aber:** auf dem Host liegt unter `viewer-dist/download/` noch der Flat-Hosting-Altbestand (`install-linux.sh`, `latest.txt`, alte Installer — live 200, von `INSTALL-LINUX.md` verlinkt). Der überlebt das `rsync --delete` nur durch `VIEWER_DIST_RSYNC_EXCLUDES` in `ops/lib.sh`, die deploy.sh **und** update.sh über `rsync_viewer_dist` teilen (bis 0.7.1 hatte nur deploy.sh die Excludes — ein Hotfix via update.sh hätte die Dateien gelöscht). Guard: `ops/tests/lib-rsync-viewer-dist.test.sh`.

## Caddyfile Footguns

- **Never blanket-block `bot`/`crawler`/`spider` as User-Agent substrings**. The original auffi.app site had `@scrapers { header_regexp User-Agent (?i)(scrapy|bot|crawler|spider|…) }` which matched every legit search-engine crawler (`Googlebot`, `bingbot`, `DuckDuckBot`, `AhrefsBot`, `LinkedInBot`, `Twitterbot`, `facebookexternalhit`…) and returned 403. Search Console couldn't fetch the sitemap; SEO outage from 2026-05-12 to 2026-05-14. The narrow allow-list lives in `caddy/Caddyfile`: scrapy, wget, curl, headlesschrome, phantomjs, nikto, sqlmap, sqlninja, nmap, masscan, metasploit, dirbuster, nuclei, wpscan. The cluster Caddyfile at `/opt/caddyserver/Caddyfile` carries the same fix — keep both in sync when adding new bad-actor signatures.
- **Caddy v2 subroute matches routes in declaration order, NOT by matcher specificity** (despite docs hinting otherwise). When a `path_regexp` matcher and a `path` matcher could both match, whichever was textually first wins. Concrete bite: `import dotfile_protection` (which expands to `path_regexp \/\.`) was placed at the top of the auffi.app block, and a later `handle /.well-known/* { reverse_proxy auffi-viewer:80 }` never fired — `/.well-known/security.txt` 403'd. Fix is positional: the `/.well-known/*` handle MUST be inserted BEFORE `import dotfile_protection`.
- **`import security_headers` + later `header X-Frame-Options DENY` does NOT override the imported value** (SEC-M1, 2026-05-17). The shared cluster `security_headers` snippet sets `X-Frame-Options "SAMEORIGIN"` + `Referrer-Policy "strict-origin-when-cross-origin"`; the per-tenant `header X-Frame-Options DENY` line below was silently ignored — live response carried SAMEORIGIN. Tried `>`/`?`/`+` prefixes, a separate delete-then-set block (`header -X-Frame-Options; X-Frame-Options DENY`) — none of them overrode. The only working fix was to NOT import `security_headers` in the auffi.app block at all and inline every header (Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, -Server) with the auffi-specific values. Likely Caddy applies the imported `header {}` block in a later phase than the inline one — quirky semantics around `header { ... }` directives that span both snippet-imports and inline blocks. **Pattern for any future per-tenant header override**: drop the import, write everything inline.
- **The repo `caddy/Caddyfile` header block is the reference; the cluster block must match it, not the other way round.** Until 0.7.1 the two had drifted (prod sent `Permissions-Policy`, `X-XSS-Protection: 0` and a 2-year preload HSTS, the repo file none of them), so a standalone self-host shipped weaker headers than auffi.app and the repo no longer documented prod. `ops/tests/caddyfile-headers.test.sh` pins the set; after changing it, replay the values into `/opt/caddyserver/Caddyfile` by hand (§ Cluster-Ops: validate, then `docker restart caddy-proxy`).
- **Four cluster-only Caddyfile patches** that don't live in the repo because the cluster Caddyfile is shared with other tenants: (1) `/api/* → auffi-backend:8080`, (2) `/dashboard/* → auffi-dashboard:80` + `redir /dashboard /dashboard/ permanent`, (3) `/.well-known/* → auffi-viewer:80` placed BEFORE dotfile_protection. Plus the scrapers-regex narrowing. **(4)** Matomo CSP: append `https://musikersuche.org` to `script-src` AND `connect-src` of the `auffi.app {}` block. **No inline-Matomo-hash needed since the 2026-05-21 Consent-Banner-Refactor** — Matomo lädt jetzt via externes `/matomo-consent.js` (covered by `'self'`). Die verbleibenden CSP-sha256-Hashes whitelisten ausschließlich JSON-LD-Inline-Blöcke — **einer pro Marketing-/Static-Page, seit dem SEO-Push 2026-06-23 rund 50 Stück** (`npm run csp:check` nennt die exakte Zahl). Nie von Hand auf „die zwei" zurückkürzen: das blockt lautlos die Structured-Data auf ~40 Seiten, und kein Test deckt das Cluster-File ab. Regenerieren mit `cd viewer && npm run csp:sync` (Guard: `npm run csp:check`), Prozedur fürs Cluster-File in `docs/ops-runbook.md` § CSP script-src. Der alte Inline-Matomo-Hash `sha256-zrNDhMThszjoh7hKKym112SwQTRucbjaJn81UYoRyow=` darf aus dem cluster-Caddyfile entfernt werden (in-repo bereits raus) — wenn er drin bleibt, ist es harmlos. In-repo `caddy/Caddyfile` carries the full set; the cluster file at `/opt/caddyserver/Caddyfile` needs the same patches by hand. If a fresh cluster host gets provisioned, replay the patches in `/tmp/patch_cluster_*.py` (the scripts are kept in `/tmp` on the dev box, not in the repo — same posture as the UFW rules).

## Matomo Cross-Tenant Trust

Die selbst-gehostete Matomo-Instanz auf `musikersuche.org/matomo/` ist eine **separate Anwendung auf demselben VPS**, die unabhängig administriert wird. Konsequenz:

- **Kompromittierung von `musikersuche.org` = Kompromittierung der Auffi-Marketing-Pages** (XSS-equivalent via die `<script src="//musikersuche.org/matomo/matomo.js">`-Injection im Matomo-Snippet). Ein logged-in User auf auffi.app/ würde dann sein `__Host-auffi_session`-Cookie an einen kontrollierten Endpoint leaken (das FAB probet aktiv `/api/me`).
- **SRI-Pin nicht möglich** weil Matomo seine matomo.js in-place updatet. Acceptable Risk solange wir musikersuche.org selbst administrieren, aber wenn dort jemals ein Dritt-Tenant hinzukommt → harte Mitigation nötig (SRI mit Versions-gepinntem matomo.js, oder Matomo-API durch unseren Backend reverse-proxyen).
- **DNS-Pin nicht codiert**: wenn `musikersuche.org` jemals den Host wechselt (z.B. CDN), wird daraus ein nicht-disclosed Drittland-Transfer. A-Record sollte stabil zur DE-IP zeigen — wenn ich es jemals ändere, MUSS ich die Datenschutzerklärung §9 + diesen Eintrag aktualisieren UND die script-src in Caddyfile re-evaluieren. Aktuell `musikersuche.org` → IONOS Frankfurt (DE).

(Security-Review SEC-M3 + DSGVO-M5, 2026-05-17.)

## Cluster-Ops Footguns

Three things that took today's (2026-05-17) Matomo + Feedback deploys to find. They're cluster-deployment-only (don't apply to a standalone-mode `docker-compose.prod.yml` host):

- **Cluster reverse-proxy is `caddy-proxy`** (image `caddy-custom:2.11.2-ratelimit`), NOT `auffi-caddy`. The latter only exists in standalone mode. `docker exec auffi-caddy …` will fail with "No such container" on cluster hosts. Use `docker exec caddy-proxy …` instead. The Caddyfile path is `/opt/caddyserver/Caddyfile` on the host (bind-mounted into the container).
- **Cluster Caddyfile has `admin off`** (line 6), so `docker exec caddy-proxy caddy reload --config /etc/caddy/Caddyfile` fails with `connect: connection refused` on the admin-API port 2019. The only reload path is `docker restart caddy-proxy` (~3 s connection blip — acceptable for a tenant-shared host but document the blip if you're scheduling it). Always `docker exec caddy-proxy caddy validate --config /etc/caddy/Caddyfile` BEFORE the restart so a syntax error doesn't take auffi.app offline.
- **`docker compose restart backend` does NOT re-read `.env.prod`.** `restart` recycles the existing container with its existing env-snapshot from start-time. New env-vars (e.g. adding `SMTP_FROM=…` or `MATOMO_*`) require `docker compose -f docker-compose.prod.yml -f docker-compose.cluster.yml --env-file .env.prod up -d --force-recreate --no-deps backend`. The deploy script does the right thing on full deploys; only manual env tweaks have this trap.
- **`ops/deploy.sh` ships + restarts coturn unconditionally, but does NOT ship the Caddyfile in cluster mode** — the asymmetry is easy to get backwards. The `coturn/` rsync (and the `auffi-coturn` restart when `turnserver.conf.tmpl` changed) runs in *both* modes (deploy.sh Step 9 + 14), so a coturn-config change like `user-quota` only needs a normal `./ops/deploy.sh` — no hand-edit on prod, and the container re-renders the `.tmpl` on the restart deploy triggers. The `caddy/` rsync, by contrast, is guarded behind standalone-only (`-z "$CLUSTER_PROXY"`): on the cluster host the shared `/opt/caddyserver/Caddyfile` is hand-maintained (see § Caddyfile Footguns above). Rule of thumb: **coturn = let deploy.sh do it; Caddyfile = hand-edit on the cluster host.** Verify a coturn change actually landed with `docker exec auffi-coturn grep user-quota /tmp/turnserver.conf` (rendered config, not the `.tmpl`).

## GeoIP Country Lookup

Module: `backend/src/geoip.ts`. The MMDB (DB-IP IP-to-Country Lite, CC-BY-4.0) is baked into the
Docker image at build time via the `geoip` stage in `backend/Dockerfile`. The destination path is
`/app/data/dbip-country-lite.mmdb`, exposed to the app through the `GEOIP_DB_PATH` env var. The
`DBIP_MONTH` build ARG defaults to `auto`: the stage tries the current month and walks back up to
three more months, failing the build only if none is downloadable. There is **no monthly chore** —
a fixed month pin hard-blocked every build (incl. hotfix deploys) once DB-IP rolled it off
(2026-08 incident). The trade-off is that the default build is not reproducible (the snapshot
depends on the build date); pass `--build-arg DBIP_MONTH=YYYY-MM` for a pinned build, which fails
loudly on a 404 (see `docs/ops-runbook.md` § GeoIP MMDB Snapshot).

**Graceful degradation.** `openCountryDb()` returns `null` if `GEOIP_DB_PATH` is unset or the file
is absent (e.g. local `npm run dev` without Docker). `lookupCountry(null, ip)` returns `null`
silently. A missing MMDB never throws, never breaks signaling — it only disables the country field
in `peer-joined` (it will be `null`).

**Privacy.** The lookup uses the full viewer IP locally on the VPS; no data is sent to a third
party. The resolved country code is sent live to the sharer for the confirm dialog only; it is
NOT logged and NOT persisted anywhere.

## Fixed-Position-Overlay darf Content nicht hiden

Allgemeines UI-Pattern, das beim Matomo-Consent-Banner (audit 2026-05-23) schmerzhaft aufschlug. Ein `position: fixed; bottom: 0`-Overlay (Banner, Toast, Cookie-Hinweis…) verdeckt by-default Content unten — beim Matomo-Banner ursprünglich als floating-Card am rechten unteren Rand, der mid-page-Paragraphen überlagerte und im Visual-Audit nicht zu übersehen war.

**Funktionierende Pattern (am Matomo-Banner exerziert)**:

- **Slim full-width Bar statt floating Card** — `left: 0; right: 0; bottom: var(--footer-height, 48px); border-top: 2px solid ink`. Nimmt eigene horizontale Linie ein, hat keine Z-Achse-Überlappung mit Content.
- **Body-padding-Reservierung beim Mount, Cleanup beim Dismiss** — JS toggled `.matomo-consent-shown` (oder semantisch passende Klasse) auf `<body>`; CSS-Regel `body.<klasse> { padding-bottom: calc(footer + 5rem) }` (Desktop) bzw. `+8rem` für narrow viewports wo der Bar in zwei Reihen wrappt. Wichtig: Cleanup MUSS sowohl Banner-DOM-Node entfernen ALS auch die Klasse vom Body — sonst bleibt nach Dismiss ein leerer Padding-Block am Page-Footer.
- **Visual-Audit zur Erkennung** — Mid-page-overlays mit nur einem Smoke-Test zu fangen ist schwer, weil Tests gerne am Page-Top scrollen. Der `viewer/tests/e2e/visual-audit.spec.ts` (24 Screenshots inkl. Matomo-Banner-Spec) sieht es sofort. Nach jedem Overlay-Patch durchlaufen lassen.

Anwendbar auf jedes künftige fixed-bottom-Overlay (Floor-Action-Bar im Mobile-View, Save-Toast, etc.).
