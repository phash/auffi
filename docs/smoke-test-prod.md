# Production Stack Smoke-Test Procedure

Validates the full `docker-compose.prod.yml` stack locally before deploying to the VPS.

---

## What This Smoke Test Covers

| Check | How |
|-------|-----|
| Backend container healthy | Docker healthcheck on `GET /healthz` |
| Caddy HTTPS reachable | `curl -sk https://localhost:8443/healthz` |
| `GET /healthz` through Caddy | Response body contains `"status":"ok"` |
| `GET /readyz` through Caddy | Response body contains `"status":"ok"` |
| `POST /turn-credentials` through Caddy | Response JSON contains `username` + `credential` |
| Viewer SPA served at `/` | HTTP 200, index.html |
| WebSocket signaling round-trip | register → code-assigned → join → peer-joined → confirm → peer-confirmed |
| coturn container running | `docker inspect` status = running |
| coturn port 3478 reachable (TCP) | `nc` probe (skipped if `nc` not installed) |
| TURN relay allocation | `turnutils_uclient` (skipped if not installed) |

---

## How to Run

```sh
# From the repo root:
./ops/smoke.sh

# Skip builds if you already have a fresh image + viewer/dist:
./ops/smoke.sh --no-build
```

The script:
1. Generates an ephemeral `TURN_SHARED_SECRET` for this run.
2. Builds `viewer/dist/` via `npm ci && npm run build`.
3. Builds the `auffi-backend:smoke` Docker image locally.
4. Creates a minimal `.env.prod` stub (required by Compose file validation; auto-deleted on teardown).
5. Starts the stack with `docker compose -f docker-compose.prod.yml -f docker-compose.smoke.yml up -d`.
6. Waits up to 60 s for the backend to become healthy, then up to 60 s for Caddy.
7. Runs all endpoint and WebSocket checks.
8. Tears down the stack and removes the stub.
9. Exits 0 (all pass) or 1 (any failure).

---

## Architecture of the Smoke Overlay

`docker-compose.smoke.yml` extends `docker-compose.prod.yml` with these changes:

| Service | What changes |
|---------|-------------|
| **backend** | Builds image locally (`auffi-backend:smoke`). Exposes port 8081 on localhost for the WS test. All env vars injected inline (no `.env.prod` needed at runtime). |
| **caddy** | Mounts `caddy/Caddyfile.local` (site address = `localhost`, `tls internal`). Uses `caddy-data-smoke` volume to isolate Caddy's local-CA material. Ports remapped to `8080` (HTTP) / `8443` (HTTPS) via `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` env vars. |
| **coturn** | Mounts `coturn/turnserver.conf.notls.tmpl` (no TLS, no-dtls) so it works without certificates. `TURN_REALM=localhost`. |
| **viewer-build** | One-shot `busybox` container that copies `./viewer/dist` into the `viewer-static` volume for Caddy to serve. |

---

## Port Mapping (Smoke vs Production)

| Service | Production | Smoke (local) |
|---------|-----------|---------------|
| Caddy HTTP | 80 | 8080 |
| Caddy HTTPS | 443 | 8443 |
| Backend (internal) | (Docker network only) | 127.0.0.1:8081 |
| coturn STUN/TURN | 3478 (host network) | 3478 (host network) |

The Caddy ports use environment variables in `docker-compose.prod.yml`:

```yaml
ports:
  - "${CADDY_HTTP_PORT:-80}:80"
  - "${CADDY_HTTPS_PORT:-443}:443"
  - "${CADDY_HTTPS_PORT:-443}:443/udp"
```

`ops/smoke.sh` exports `CADDY_HTTP_PORT=8080` and `CADDY_HTTPS_PORT=8443` before starting the stack.

---

## TLS During Smoke Test

Caddy's `tls internal` directive makes Caddy issue a certificate from its own local CA. The certificate is self-signed and the browser will warn about it. All `curl` calls use `-sk` to skip certificate verification. Node's WebSocket smoke test (`scripts/smoke-ws.mjs`) connects directly to the backend on port 8081 (plain WS) to avoid the TLS verification issue.

For the production deployment, Caddy obtains a real Let's Encrypt certificate via HTTP-01 challenge automatically on first startup.

---

## coturn Without TLS

In the smoke test, coturn uses `coturn/turnserver.conf.notls.tmpl` which disables TLS and DTLS:

```
no-tls
no-dtls
```

This avoids the need for a certificate at test time. On the real VPS, coturn uses the production template (`coturn/turnserver.conf.tmpl`) which requires a real cert (see `ops/README.md` for the certbot procedure).

---

## Known Issues Found During Initial Run

| Issue | Cause | Fix Applied |
|-------|-------|-------------|
| Backend healthcheck failed | `wget localhost:8080` resolved `localhost` to `::1` (IPv6) on Alpine; backend only bound to IPv4 `127.0.0.1` initially (then `0.0.0.0`) | Changed healthcheck to `http://127.0.0.1:8080/healthz` in `docker-compose.prod.yml` |
| Port 80/443 conflicts | Other local containers occupied 80 on the dev box | Added `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` env-var ports in `docker-compose.prod.yml`; smoke script sets them to 8080/8443 |
| coturn crashing (`envsubst: not found`) | `envsubst` (from gettext) is not present in `coturn/coturn:4.6.3-alpine` | Replaced `envsubst` with `sed` substitution in `coturn/entrypoint.sh` |

---

## Smoke Test Results (2026-05-11)

```
PASS  backend container healthy
PASS  Caddy HTTPS reachable (port 8443)
PASS  /healthz → {status:ok}
PASS  /readyz → {status:ok}
PASS  POST /turn-credentials → valid JSON with username+credential
PASS  Viewer index.html served (HTTP 200)
PASS  WebSocket signaling (register → code-assigned → join → peer-confirmed)
PASS  coturn container running
SKIP  coturn port 3478 reachable (TCP)  (nc not found on dev box)
SKIP  TURN relay allocation via turnutils_uclient  (install: pacman -S coturn)

Total: 8 passed, 0 failed, 2 skipped
```

Exit code: 0 — SMOKE TEST PASSED.

---

## Files Created / Modified

| File | Purpose |
|------|---------|
| `caddy/Caddyfile.local` | Local Caddyfile with `tls internal` and `localhost` site address |
| `coturn/turnserver.conf.notls.tmpl` | coturn config without TLS for local testing |
| `coturn/entrypoint.sh` | Fixed: replaced `envsubst` (missing in alpine) with `sed` |
| `docker-compose.prod.yml` | Fixed: healthchecks use `127.0.0.1` not `localhost`; Caddy ports use env vars |
| `docker-compose.smoke.yml` | Compose overlay for local smoke testing |
| `scripts/smoke-ws.mjs` | Node.js WebSocket signaling smoke test |
| `ops/smoke.sh` | Full smoke-test orchestrator script |
