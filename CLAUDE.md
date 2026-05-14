# Auffi — Project Conventions

## Product Goals

Three non-negotiable goals that **every** engineering decision should serve. When a design choice trades off, fall on the side of these.

1. **Einfache Steuerung** — A non-technical helper opens a URL, types a 9-digit code, clicks Verbinden. Done. The sharer-user clicks Akzeptieren, picks a monitor. Done. No accounts, no installs (for ad-hoc), no jargon in the UI, no settings the helper has to discover. German first.

2. **Verlässliche Verbindung** — The connection survives Wi-Fi blips (10 s ICE-disconnected grace), reuses the same session on reconnect within 30 s, falls back to TURN when P2P is blocked, and tears down predictably when something genuinely failed. The user should never see a stuck "Verbindung wird hergestellt…" without a path forward. Logs use `dbg_log()` so failures are diagnosable post-hoc.

3. **Sichere Kommunikation** — TLS everywhere (Let's Encrypt via Caddy). WebRTC media uses DTLS-SRTP, mandatory. Session codes are server-burned after 5 wrong attempts and TTL-capped at 10 minutes. Sharer always confirms incoming peers (except in the future unattended mode where the device-token + per-device password gate access). TURN credentials are HMAC-ephemeral. No PII in logs, no third-party trackers, argon2id for passwords, SHA-256 for at-rest token hashes. See `docs/security-review-2026-05.md` for the audit.

## Project Overview

TeamViewer-style screen-sharing tool. Live at `https://auffi.app`. Four components in one monorepo:

- `backend/` — Node.js + Fastify WebSocket signaling server, REST `/api/*`, better-sqlite3. Dockerized.
- `viewer/` — Browser-based viewer (Vite + TypeScript). Static build, served by reverse proxy.
- `sharer/` — Tauri 2 native desktop app (Rust core + Webview UI). Supports both ad-hoc 9-digit-code flow and unattended-access mode (paired device, persistent WSS, optional `auto_accept`).
- `dashboard/` — Browser SPA for the unattended-access surface only (Vite + TypeScript). Account signup/verify/login, device pairing codes, device list. Not loaded for the ad-hoc flow.

Target deployment: Linux VPS, **everything runs in Docker** (backend, coturn, reverse proxy, optional DB).

**Wayland capture** goes through GStreamer (`pipewiresrc ! videoconvert ! BGRA ! appsink`) rather than direct `pipewire-rs` — the GStreamer element handles DMA-BUF / modifier negotiation that Plasma 6 rejects on the raw SHM path. See `sharer/src-tauri/src/capture/gst_portal.rs`.

**Entry points:**
- Backend: `backend/src/index.ts` → `server.ts` (Fastify) → `signaling.ts` (WS rooms) + `auth/`, `devices/`, `account/`, `admin/` route modules
- Viewer: `viewer/src/main.ts` → `ui.ts` (UI wiring) → `webrtc-client.ts` (peer)
- Sharer: `sharer/src-tauri/src/lib.rs` (Tauri commands) → `capture/mod.rs` (per-OS capture) → `webrtc_peer.rs` (encoder/peer). Unattended path: `heartbeat.rs` (persistent WSS) + `unattended_cmd.rs` (Tauri commands + forwarder loop)
- Dashboard: `dashboard/src/main.ts` → `router.ts` (history-API SPA) → `views/*.ts`
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

# Dashboard (unattended-access SPA — only needed if you're working on the account/device flow)
cd dashboard && npm run dev        # vite on :5174
cd dashboard && npm test           # vitest (jsdom + custom router)
cd dashboard && npm run build      # static dist/

# Local stack (backend + coturn behind dev Caddy)
docker compose up --build

# Production deploy (to musikersuche@musikersuche.org:/opt/screenie)
./ops/deploy.sh                    # idempotent — builds, transfers, starts
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
- **No third-party trackers** in the viewer. No analytics SDKs, no Google Fonts CDN, no external CSS. Self-host everything.
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

## Docker Conventions

- Each component that runs on a server has its own `Dockerfile` (multi-stage build).
- Root `docker-compose.yml` for local dev (backend + dependencies).
- Root `docker-compose.prod.yml` for production (backend + coturn + reverse proxy + Let's Encrypt + optional DB).
- Use **pinned image tags** (`node:20.18-alpine`, never `latest`).
- Health checks defined for every long-running service.
- No secrets in `Dockerfile` or images. Configuration via env vars from `.env` (gitignored).

## Reverse Proxy

**Caddy** for TLS + Let's Encrypt + native WebSocket support. Two production modes:

- **Standalone** — `docker-compose.prod.yml` brings up our own Caddy on :80/:443.
- **Cluster** (current prod) — `docker-compose.prod.yml` + `docker-compose.cluster.yml` overlay. Our Caddy is disabled; the cluster's shared Caddy at `/opt/caddyserver/Caddyfile` reverse-proxies `auffi.app` to `auffi-backend:8080` via the external `caddy-proxy` network. The `viewer` runs as a small nginx-alpine sidecar serving the static dist.

TURN certs are shared via the `turn-cert-stage` sidecar copying from the Caddy cert volume to `turn-certs-staged`.

## Definition of "Done" per Task

A task is done when **all** of these hold:

1. All tests pass: `npm test`, `cargo test`, etc.
2. Coverage ≥ 70 % for new code.
3. Lint passes: `eslint`, `cargo clippy -- -D warnings`.
4. Type check passes: `tsc --noEmit`, `cargo check`.
5. Code committed atomically with Conventional Commit message.
6. No new TODO / FIXME / `as any` / dead code introduced.
7. If task touched UI: manual smoke-tested.
