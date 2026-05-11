# Screenie — Project Conventions

## Project Overview

TeamViewer-style screen-sharing tool. Three components in one monorepo:

- `backend/` — Node.js + Fastify WebSocket signaling server. Dockerized.
- `viewer/` — Browser-based viewer (Vite + TypeScript). Static build, served by reverse proxy.
- `sharer/` — Tauri 2 native desktop app (Rust core + Webview UI).

Target deployment: Linux VPS, **everything runs in Docker** (backend, coturn, reverse proxy, optional DB).

Specs and plans live under `docs/superpowers/`.

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

## Docker Conventions

- Each component that runs on a server has its own `Dockerfile` (multi-stage build).
- Root `docker-compose.yml` for local dev (backend + dependencies).
- Root `docker-compose.prod.yml` for production (backend + coturn + reverse proxy + Let's Encrypt + optional DB).
- Use **pinned image tags** (`node:20.18-alpine`, never `latest`).
- Health checks defined for every long-running service.
- No secrets in `Dockerfile` or images. Configuration via env vars from `.env` (gitignored).

## Reverse Proxy Choice

Use **Caddy** as the reverse proxy (instead of Nginx) for production:
- Automatic Let's Encrypt — no manual cert handling.
- Simpler config (Caddyfile) than Nginx for this use case.
- Native WebSocket support, no special config.

## Definition of "Done" per Task

A task is done when **all** of these hold:

1. All tests pass: `npm test`, `cargo test`, etc.
2. Coverage ≥ 70 % for new code.
3. Lint passes: `eslint`, `cargo clippy -- -D warnings`.
4. Type check passes: `tsc --noEmit`, `cargo check`.
5. Code committed atomically with Conventional Commit message.
6. No new TODO / FIXME / `as any` / dead code introduced.
7. If task touched UI: manual smoke-tested.
