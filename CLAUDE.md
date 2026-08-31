# Auffi — Project Conventions

## Product Goals

Three non-negotiable goals that **every** engineering decision should serve. When a design choice trades off, fall on the side of these.

1. **Einfache Steuerung** — A non-technical helper opens a URL, types a 9-digit code, clicks Verbinden. Done. The sharer-user clicks Akzeptieren, picks a monitor. Done. No accounts, no installs (for ad-hoc), no jargon in the UI, no settings the helper has to discover. German first.

2. **Verlässliche Verbindung** — The connection survives Wi-Fi blips (10 s ICE-disconnected grace), reuses the same session on reconnect within 30 s, falls back to TURN when P2P is blocked, and tears down predictably when something genuinely failed. The user should never see a stuck "Verbindung wird hergestellt…" without a path forward. Logs use `dbg_log()` so failures are diagnosable post-hoc.

3. **Sichere Kommunikation** — TLS everywhere (Let's Encrypt via Caddy). WebRTC media uses DTLS-SRTP, mandatory. Session codes are TTL-capped at 10 minutes and bounded against guessing by a per-IP rate-limit (5/min); the 5-attempt lockout applies to the password surfaces (account + per-device unattended), not the ad-hoc code. Sharer always confirms incoming peers (except in the future unattended mode where the device-token + per-device password gate access). TURN credentials are HMAC-ephemeral. No PII in logs, no third-party trackers, argon2id for passwords, SHA-256 for at-rest token hashes. See `docs/security-review-2026-05.md` for the audit and `docs/encryption-architecture.md` for the end-to-end crypto-chain walkthrough.

**License:** AGPL-3.0-only (`LICENSE`). Forks that host Auffi as a service MUST publish their modifications under the same license — closes the SaaS-loophole of plain GPL-3.0. When new code lands in `backend/` / `viewer/` / `dashboard/` / `sharer/`, it MUST be AGPL-3.0-compatible (MIT, Apache-2.0, BSD are fine; GPL-2-only or proprietary SDKs are NOT).

## Project Overview

TeamViewer-style screen-sharing tool. Live at `https://auffi.app`. Four components in one monorepo:

- `backend/` — Node.js + Fastify WebSocket signaling server, REST `/api/*`, better-sqlite3. Dockerized.
- `viewer/` — Browser-based viewer (Vite + TypeScript). Static build, served by reverse proxy.
- `sharer/` — Tauri 2 native desktop app (Rust core + Webview UI). **Linux + Windows only — no macOS backend** (`capture/mod.rs` has only `target_os = "linux"` / `"windows"` arms; no ScreenCaptureKit/CGEvent capture or input). Supports both ad-hoc 9-digit-code flow and unattended-access mode (paired device, persistent WSS, optional `auto_accept`).
- `dashboard/` — Browser SPA for the unattended-access surface only (Vite + TypeScript). Account signup/verify/login, device pairing codes, device list. Not loaded for the ad-hoc flow.

Target deployment: Linux VPS, **everything runs in Docker** (backend, coturn, reverse proxy, optional DB).

**Wayland capture** goes through GStreamer (`pipewiresrc ! videoconvert ! BGRA ! appsink`) rather than direct `pipewire-rs` — the GStreamer element handles DMA-BUF / modifier negotiation that Plasma 6 rejects on the raw SHM path. See `sharer/src-tauri/src/capture/gst_portal.rs`.

**Entry points:**
- Backend: `backend/src/index.ts` → `server.ts` (Fastify) → `signaling.ts` (WS rooms) + `auth/`, `devices/`, `account/`, `admin/`, `feedback/`, `downloads/`, `tracking/` route modules. Notable: `admin/feedback.ts` (list/patch/reply/delete; reply persists BEFORE SMTP so transient mail failures keep the typed reply as a draft), `admin/stats.ts` (`/api/admin/stats` + `/api/admin/stats/codes`), `downloads/handlers.ts` (KNOWN_ASSETS-Allow-List — bump per release; `/api/downloads/file/:asset[?tag=vX.Y.Z]`-Stream-Proxy s. `docs/footguns.md` § Download-Proxy Patterns), `tracking/matomo.ts` (server-side code_created Matomo POST), `tracking/code_events.ts` (per-mint DB-Row in `code_events`-Tabelle, 365 d Retention via top-level `purge.ts`, i.e. `backend/src/purge.ts`), `geoip.ts` (optionaler Country-Lookup für den Ad-hoc-Confirm-Dialog via `maxmind`; MMDB-Pfad aus `GEOIP_DB_PATH`, degradiert lautlos zu „kein Land" wenn ungesetzt/fehlend).
- Viewer: `viewer/src/main.ts` → `ui.ts` (UI wiring) → `webrtc-client.ts` (peer) + `zoom.ts` + `pan.ts` (pure zoom/pan-state helpers). Plus `notch-connect.ts` (mittige „Verbinden"-CTA in der Topbar — Scroll/Fokus aufs Code-Feld; Topbar-Variante A mit Verbinden + Sharer-Download-Pille, s. `docs/superpowers/specs/2026-06-15-prominent-sharer-download-and-help-design.md`), `help-modal.ts` (das „?"-Hilfe-Modal „So funktioniert Auffi", Focus-Trap via `focus-trap.ts`) und `matomo-consent-decision.ts` (pure Decision-Table für den Consent-Banner). Static `viewer/public/` ships standalone vanilla-JS overlays (`feedback-fab.js`, `help-overlay.js` — das „?"-Hilfe-Overlay für die statischen Seiten (injiziert Trigger + Modal, DE/EN via `<html lang>`; Inhalt muss mit dem App-Modal in `index.html` synchron bleiben — Guard: `tests/help-content-sync.test.ts`), `download/counts.js`, `matomo-consent.{js,css}`) that the 4 marketing-pages + dashboard link directly — they live outside the Vite-bundle so the static-pages can use them without TypeScript. Self-hosted IBM Plex woff2-Fonts (4 files, ~76 KB latin-subset) liegen unter `viewer/public/fonts/` (separate Kopie vom dashboard, beide nginx-Container haben eigene Asset-Sets). Visual-Audit-Playwright-Spec unter `viewer/tests/e2e/visual-audit.spec.ts` (Screenshots gegen prod, siehe Quick-Commands). Plus `connect-messages.ts` (pure `friendlyJoinError` + `connectTimeoutMessage` — deutsche Connect-Fehler/Timeout-Copy; der Connect-Flow hat ein 60s-Confirm-/30s-Media-Timeout-Backstop + einen Abbrechen-Button, verdrahtet in `ui.ts`).
- Sharer: `sharer/src-tauri/src/lib.rs` (Tauri commands) → `capture/mod.rs` (per-OS capture) → `webrtc_peer.rs` (encoder/peer). Unattended path: `heartbeat.rs` (persistent WSS) + `unattended_cmd.rs` (Tauri commands + forwarder loop). Input pipeline `input.rs` — `InputController` tracks held buttons/keys and releases them in `Drop` (gh #97 fix; otherwise a viewer-disconnect mid-click leaves the OS thinking the button is still down). Update-Notifier: `update_check.rs` (Tauri command `check_for_update`, GitHub-Releases-API gegen `CARGO_PKG_VERSION`) + `sharer/src/update-banner.ts` (UI-Banner mit „Jetzt herunterladen"-Link auf auffi.app/download/). Password-Eye-Toggle ist inline in `sharer/src/unattended.ts` dupliziert (`wrapPasswordWithEyeToggle()`) — sharer-Webview-Bundle ist separat vom dashboard, kann den Helper nicht importieren.
- Dashboard: `dashboard/src/main.ts` → `router.ts` (history-API SPA) → `views/*.ts` (incl. `admin-feedback.ts` mit inline-reply UI, `admin-stats.ts` mit Users/Devices/Connections/Code-Mints inkl. perDay-Bar-Chart). Admin-Section (#53/#54): `admin-nav.ts` (`visibleRoutes` + `updateActiveNav` + `isAdminGatedPath` als pure Helper), `views/admin-overview.ts` (KPI-Tiles), `views/admin-users.ts` (Filter-Chips + cursor-Pagination + debounced Search), `views/admin-user-detail.ts` (Suspend/Promote/Delete + Audit-Trail), `views/admin-403.ts` (friendly "kein Admin"-Seite), `components/confirm-with-reason.ts` (reusable destruktives-Confirm-Modal), `components/password-field.ts` (`wrapPasswordField()`-Helper für Eye-Toggle). Plus `components/feedback-fab.ts`. Self-hosted IBM Plex woff2-Fonts (4 Files) unter `dashboard/public/fonts/`. Admin-UI- + Design-System-Konventionen: `docs/frontend-patterns.md`.
- Cross-component wire format: `docs/protocol.md` — both sides of every message reference this. The unattended-access message family (pw-attempt / pw-check / pw-check-result / needs-password / wrong-password / locked / rejected-by-user / unattended-hello) is documented in protocol.md too (added 2026-05-29). The sharer-internal `confirmId` routing stays OUT of the wire spec — it never crosses the WSS (see `sharer/src-tauri/src/unattended_cmd.rs`). For exact Rust shapes refer to `sharer/src-tauri/src/heartbeat.rs::BackendFrame|SharerFrame`.

Specs and plans live under `docs/superpowers/`.

## Detail-Dokumentation (Referenzen)

Tieferes Referenzmaterial wurde aus dieser Datei ausgegliedert, um sie schlank zu halten. Vor Arbeiten im jeweiligen Bereich dort nachschlagen:

- **`docs/footguns.md`** — Load-bearing settings & Footguns: WebRTC Connectivity, Sharer Teardown, Unattended-Access, AppImage-Build, Download-Proxy, Caddyfile, Matomo Cross-Tenant Trust, Cluster-Ops, Fixed-Position-Overlay.
- **`docs/ops-runbook.md`** — Ops: Rebrand-Naming, Production-Deploy, OG-image, Sharer-Release, Admin-Promote, Docker Conventions, Reverse Proxy, Daily Backup + Restore, Deploy-Skript-Robustheit.
- **`docs/frontend-patterns.md`** — Admin-Section Patterns + Calm Fresh Aesthetic (emerald/mint Design-System, Tokens, Fonts).
- **`docs/matomo-dsgvo.md`** — Matomo-Exception zur No-Tracker-Regel (Consent-Banner, cookieless, Backend-Code-Mint-Tracking).

## Quick Commands

```bash
# Backend (Fastify signaling)
cd backend && npm run dev          # tsx watch on :8080
cd backend && npm test             # vitest

# Viewer (browser SPA)
cd viewer && npm run dev           # vite on :5173
cd viewer && npm run build         # static dist/
cd viewer && npm run test:e2e      # Playwright

# Visual-Audit gegen live prod (24 Screenshots in /tmp/visual-audit/):
# 7 Pages × {light, dark, mobile} + Password-Toggle-Flow + Notch-Click + Matomo-Banner.
# Nach jedem Design-Pass laufen lassen, dann die PNGs via Read-Tool durchgehen.
cd viewer && npx playwright test tests/e2e/visual-audit.spec.ts --workers=1

# Sharer (Tauri desktop app)
cd sharer && npm run tauri:dev     # native window + DevTools
cd sharer && npm run tauri:build   # .deb / .rpm / .AppImage
cd sharer/src-tauri && cargo test --lib                          # 239 Rust unit tests — note nested dir
cd sharer/src-tauri && cargo clippy --lib --tests -- -D warnings

# Dashboard (unattended-access SPA — only needed if you're working on the account/device flow)
cd dashboard && npm run dev        # vite on :5174
cd dashboard && npm test           # vitest (jsdom + custom router)
cd dashboard && npm run build      # static dist/

# Local stack (nur backend — voller Stack lokal via ./ops/smoke.sh)
docker compose up --build

# Production deploy
./ops/deploy.sh                    # idempotent — Tests + Build + Transfer + Compose-Up + Health + Log
./ops/deploy.sh --yes              # ohne Confirm | --dry-run | --rollback | --skip-tests
```

Production-Deploy-Flags, OG-image-Rebuild, Sharer-Release-Prozedur und Admin-Promote-SQL: siehe `docs/ops-runbook.md`.

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
- **No third-party trackers** in the viewer. No analytics SDKs, no Google Fonts CDN, no external CSS. Self-host everything. *Exception:* a self-hosted Matomo on the same VPS (opt-in consent-banner, cookieless) — full architecture in `docs/matomo-dsgvo.md`, threat-model in `docs/footguns.md` § Matomo Cross-Tenant Trust.
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

## Definition of "Done" per Task

A task is done when **all** of these hold:

1. All tests pass: `npm test`, `cargo test`, etc. (Baseline at 2026-08-28 (v0.6.6): backend 478, sharer-lib 256 (+ 9 `#[ignore]` Display-requiring), viewer 583, dashboard 174, sharer-js 83. `purge.test.ts` hält timing-sensitive Scheduler-Tests, die in Full-Suite-Läufen intermittierend failen können — re-run the flaked file ISOLATED before believing a red run; keine Regression. Drops are regressions. Run sharer's display-requiring tests via `cd sharer/src-tauri && cargo test --lib -- --ignored` on a host with X11/Wayland.)
2. Coverage ≥ 70 % for new code.
3. Lint passes: `cargo clippy -- -D warnings`. (ESLint is NOT wired in any package despite being listed here historically — tracked in gh #108. Interim TS gate: `tsc --noEmit` runs in CI for backend/viewer/dashboard/sharer-webview.)
4. Type check passes: `tsc --noEmit`, `cargo check`.
5. Code committed atomically with Conventional Commit message.
6. No new TODO / FIXME / `as any` / dead code introduced.
7. If task touched UI: manual smoke-tested.
