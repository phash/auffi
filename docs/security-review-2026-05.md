# Auffi Security & Quality Review — 2026-05

Scope: `backend/`, `sharer/`, `viewer/`. Conducted after the unattended-backend (#9-#15) and admin-backend (#41-#52) phases shipped and before any frontend/dashboard work begins. References `commit 4f4b6ad` and earlier.

## 1. Quality / Test coverage

| Package | Tool | Statements | Branches | Lines | Status |
|---------|------|-----------|----------|-------|--------|
| backend (TS + Vitest)            | v8        | 87.53 % | 76.17 % | 90.02 % | ✅ above 70 % target |
| viewer  (TS + Vitest)            | v8        | 97.15 % | 89.75 % | 98.14 % | ✅ |
| sharer  (TS + Vitest)            | v8        | 100 %   | 95.65 % | 100 %   | ✅ (only `tabs.ts`, `monitor-display.ts`, `trusted-peers.ts` are unit-testable; Tauri-API wiring in `main.ts` is excluded) |
| sharer  (Rust)                   | tarpaulin | _measurement pending — long build_ | | | 69 Rust unit tests passing |

**Backend hot-spots that could use more coverage** (still > 70 % but worth a follow-up):

- `src/auth/tokens.ts` — only `newToken` exercised; `hashToken` and `timingSafeEquals` are covered transitively but not directly tested.
- `src/admin/audit.ts` — 65 % branch coverage. Filter-composition edge cases not all hit.
- `src/admin/devices.ts` — 72 %. The `reset-rate-limit` POST path needs an explicit test.

None of these block the 70 % gate. Logging as a follow-up rather than a blocker.

## 2. Security review

### What's good (verified)

| Surface | Setting | Verified location |
|---------|---------|-------------------|
| Password hashing  | argon2id, m=64 MiB, t=3, p=1 (≈250 ms on 1 vCPU) | `backend/src/auth/argon.ts:14-19` |
| Login timing      | Constant-time via decoy hash on missing-account path | `backend/src/auth/argon.ts:56-84` |
| Session cookie    | HttpOnly + Secure + SameSite=Strict + Path=/ + 30 d Max-Age | `backend/src/auth/sessions.ts:39-51` |
| Session storage   | 256-bit random token, only sha256 hash persisted | `backend/src/auth/tokens.ts`, `sessions.ts:27-28` |
| Token-link tables | All single-use, marked `used_at` inside a `db.transaction()` | `backend/src/auth/handlers.ts:153-160, 294-303` |
| Password reset    | Invalidates **all** sessions on success | `handlers.ts:302` |
| Cookie parser     | Custom parser (no third-party dep), ignores duplicate cookies after first match | `sessions.ts:75-87` |
| SQL injection     | All queries use `?` placeholders; the single dynamic `UPDATE devices` joins only literal `"col = ?"` strings, never user input | `devices/handlers.ts:194` |
| LIKE injection    | `%` and `_` escaped with `!` as ESCAPE char | `admin/users.ts:37-39` |
| Rate limits       | Per-endpoint via `@fastify/rate-limit`; signup 3/h, login 5/min, reset 5/h, TURN 10/min, signaling joins 5/min, per-peer WS msg 50/10 s | scattered |
| TURN credentials  | HMAC-SHA1 (RFC 5766 mandate), 1 h TTL, Origin allow-list AND active-session gate | `backend/src/turn-credentials.ts` |
| WSS Origin gate   | Pre-handshake check in `verifyClient`, returns proper 403 (not the protocol-level 1008) | `server.ts:94-105` |
| WebRTC encryption | DTLS-SRTP default in webrtc-rs 0.17.1 and browser native; never disabled | `sharer/src-tauri/src/webrtc_peer.rs:106-111` |
| TLS for sharer    | tokio-tungstenite + reqwest both use `rustls-tls-native-roots`; no `danger_accept_invalid_certs` anywhere | `sharer/src-tauri/Cargo.toml:16,28` |
| Caddy headers     | HSTS, X-Frame-Options, X-Content-Type-Options, no-referrer, tight CSP (no `unsafe-inline`) | `caddy/Caddyfile:13-19` |
| Bot UA filter     | scrapy / wget / curl / bot / crawler / spider / sqlmap / nmap / nikto / phantomjs 403 (with /healthz exception). **Erratum (2026-05-14):** the generic `bot` / `crawler` / `spider` substrings 403'd Googlebot, bingbot & co. and caused a two-day SEO outage; they were removed. The audited posture is NOT the one to restore — the current narrow list and the rule live in `docs/footguns.md` § Caddyfile Footguns. | `caddy/Caddyfile:23-30` |
| Caddy rate-limit  | 300/min general zone, 10/min on /turn-credentials, both per-IP | `caddy/Caddyfile:36-54` |
| Log redaction     | `cookie`, `authorization`, `x-forwarded-for`, `x-real-ip` all stripped from request logs | `server.ts:38-45` |
| DSGVO IP prefix   | Signaling: first octet only; audit log: first two octets — never the full IP | `signaling.ts:71-76`, `admin/middleware.ts:50-63` |

### Fixed in this review (commit 4f4b6ad)

1. **`trustProxy` not enabled.** Behind the cluster's Caddy reverse-proxy, `req.ip` resolved to Caddy's container IP for every request, collapsing every per-IP rate limiter into a single shared bucket. Fixed in `server.ts` — Fastify now reads `X-Forwarded-For` because the backend port is not exposed outside the docker network. Without this fix an attacker could exhaust signup / login attempts for everyone with a single source IP.
2. **CORS allowed only `POST`.** `/api/me` (PATCH/DELETE), `/api/devices/:id` (PATCH/DELETE), `/api/admin/users/:id` (PATCH/DELETE), the `GET` listing endpoints — all would silently fail cross-origin preflight. Now allows GET/POST/PATCH/DELETE, with `credentials: true` so the session cookie travels on cross-origin authenticated requests.

### Known minor items (not fixed — rationale below)

- **Portal restore token file permissions** (`sharer/src-tauri/src/capture/gst_portal.rs:64-71`). Written via `std::fs::write` which inherits umask (typically 0644). Lives under `~/.local/share/auffi/` which is itself 0700 on a default Linux install, so the world-readable bit is moot. The token alone also can't be used to capture a screen without going through the user's DBus session + portal dialog. Could be tightened to 0600 for defence-in-depth; not fixing now because it's not exploitable in the threat model.
- **`attemptCounts` map in `signaling.ts`** can technically grow per-IP forever, but a 60 s sweep interval in `server.ts:114-119` already evicts stale entries. No leak.
- **Lazy `TIMING_DECOY` init** (`auth/argon.ts:58-68`) can race on first concurrent login and compute the decoy twice. Result is correct either way — harmless.

## 3. Bot hardening

The existing posture is already strong (Caddy-level UA filter + per-IP rate limit, backend-level per-endpoint rate limit, per-peer WS message cap, per-IP rate-limit on join attempts (5/min) + 10-min TTL on ad-hoc codes, Origin + session-code gate on TURN). The remaining bot-vector worth considering is **automated mass signup**: even at the 3-per-hour limit, a distributed botnet could exhaust SMTP volume over time.

Possible follow-ups (none implemented):

- Add an `INSERT INTO accounts` audit log entry so the admin overview surfaces signup spikes.
- Consider a proof-of-work (Altcha or hashcash) on the signup form if abuse becomes real — friction-light and self-hostable.
- A `robots.txt` denying everything except `/` would discourage well-behaved crawlers from hitting the dashboard.

These are not currently warranted; flagged for if abuse traffic shows up in logs.

## 4. Encryption — verified

| Channel | Algorithm | Verified |
|---------|-----------|----------|
| Sharer ↔ backend (signaling)    | TLS 1.2/1.3 via rustls-tls-native-roots | `Cargo.toml:16` |
| Sharer ↔ backend (turn-creds)   | TLS 1.2/1.3 via reqwest+rustls          | `Cargo.toml:28` |
| Viewer ↔ backend (signaling)    | TLS via Caddy → backend                  | `caddy/Caddyfile` |
| Viewer ↔ sharer (media+data)    | DTLS-SRTP (mandatory)                    | webrtc-rs default |
| Sharer ↔ coturn (ICE relay)     | TLS at the WSS / TURNS endpoint          | `Caddyfile:46` |
| Password hashes in DB           | argon2id with strong params              | `auth/argon.ts:14-19` |
| Token hashes in DB              | SHA-256 (sessions, email verifications, password resets, device tokens) | `auth/tokens.ts` |
| TURN credentials                | HMAC-SHA1 over `expiry:uuid` (RFC 5766 mandate) | `turn-credentials.ts:32` |

No plaintext secrets persisted. No `danger_accept_invalid_certs` / `rejectUnauthorized: false` anywhere.

## 5. 2FA scoping

Not currently implemented. Plausible MVP shape if added:

- **TOTP enrollment** at `/api/me/2fa/enroll` → returns base32 secret + `otpauth://` URL for the user's authenticator app.
- **Confirmation** at `/api/me/2fa/verify` → atomically enables 2FA after the user proves they scanned the QR.
- **Login flow** — after password succeeds, return `{ requires_2fa: true, intermediate_token: "..." }` instead of a session cookie. A second `POST /api/auth/login/2fa` with the TOTP completes the session.
- **Recovery codes** — 10 single-use codes generated at enrollment, shown once, stored as sha256 hashes in a new `recovery_codes` table.
- **Admin enforcement** — admins must have 2FA; the `requireAdmin` middleware can short-circuit to a "2FA required" response.

Schema impact: extend `accounts` with `totp_secret_encrypted` (use libsodium / Node `crypto.createCipheriv`-AES-GCM for at-rest encryption of the shared secret) and `totp_enabled_at`; add `recovery_codes` table.

Skipping unless explicitly asked — the dashboard frontend (#28-#35) is the bigger blocker right now and a 2FA-less admin login is fine for the small initial user base.

## 6. GeoIP country lookup — DSGVO posture

The country lookup runs **locally** on the VPS using a static reference MMDB (DB-IP IP-to-Country
Lite, CC-BY-4.0). The full viewer IP is resolved server-side only; it is never forwarded to any
third-party service. The resolved ISO-3166-1-alpha-2 country code is sent live to the sharer via the
existing `peer-joined` message for display in the confirm dialog. It is **not** written to any log
and **not** persisted in the database. The MMDB itself is static reference data with no personal
data content and therefore requires no retention policy.

## 7. Recommended follow-ups

1. (optional) Tarpaulin coverage measurement for sharer Rust crate once the long build completes.
2. (optional) Direct unit tests for `tokens.ts` and the `reset-rate-limit` admin path to close the coverage gaps noted in §1.
3. (deferred) 2FA implementation if/when needed.
