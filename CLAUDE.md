# Auffi — Project Conventions

## Project Overview

TeamViewer-style screen-sharing tool. Live at `https://auffi.app`. Three components in one monorepo:

- `backend/` — Node.js + Fastify WebSocket signaling server. Dockerized.
- `viewer/` — Browser-based viewer (Vite + TypeScript). Static build, served by reverse proxy.
- `sharer/` — Tauri 2 native desktop app (Rust core + Webview UI).

Target deployment: Linux VPS, **everything runs in Docker** (backend, coturn, reverse proxy, optional DB).

**Wayland capture** goes through GStreamer (`pipewiresrc ! videoconvert ! BGRA ! appsink`) rather than direct `pipewire-rs` — the GStreamer element handles DMA-BUF / modifier negotiation that Plasma 6 rejects on the raw SHM path. See `sharer/src-tauri/src/capture/gst_portal.rs`.

**Entry points:**
- Backend: `backend/src/index.ts` → `server.ts` (Fastify) → `signaling.ts` (WS rooms)
- Viewer: `viewer/src/main.ts` → `ui.ts` (UI wiring) → `webrtc-client.ts` (peer)
- Sharer: `sharer/src-tauri/src/lib.rs` (Tauri commands) → `capture/mod.rs` (per-OS capture) → `webrtc_peer.rs` (encoder/peer)
- Cross-component wire format: `docs/protocol.md` — both sides of every message reference this.

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

`println!` / `eprintln!` from inside Tauri command handlers are **swallowed by `tauri-cli` pipe buffering** — you will see nothing on stdout. Use the `dbg_log()` helper in `sharer/src-tauri/src/lib.rs` instead; it appends to `/tmp/auffi-debug.log` with an explicit flush. Tail that file while running `tauri:dev`.

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
