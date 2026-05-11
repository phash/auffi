# Screenie Phase 4 — TURN + Production-Deployment (Docker)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Production-Deployment auf IONOS VPS (MRD-Cluster). TURN-Relay (coturn) für restriktive Netzwerke. Free-Tier-Limit (10 Min / 500 MB pro TURN-Session). **Alles Server-seitige läuft in Docker** (Backend, coturn, Reverse Proxy).

**Vorrausetzung:** Phase 3 lokal stabil (Stream + Input + Files via P2P).

**Tech additions:**
- **coturn** in Docker (`coturn/coturn` Image, exakter Tag).
- **Caddy** als Reverse Proxy (automatisches Let's Encrypt, kein manuelles Cert-Handling).
- **Optional**: Postgres in Docker — nur als Hook für späteren Premium-Account. MVP nutzt es noch nicht.

**Test strategy:** Wir testen das Production-Setup zunächst lokal via `docker-compose.prod.yml`, dann auf dem echten VPS. TURN-Verbindung verifiziert per `turnutils_uclient` und über einen E2E-Test, der STUN deaktiviert um TURN-Pfad zu erzwingen.

---

## File Structure

```
docker-compose.prod.yml                          # production multi-service compose
.env.prod.example                                # production env template

backend/
  src/turn-credentials.ts                        # new — HMAC TURN credential endpoint
  src/server.ts                                  # wire turn-credentials route
  tests/turn-credentials.test.ts                 # new

caddy/
  Caddyfile                                      # reverse proxy + Let's Encrypt config

coturn/
  Dockerfile                                     # thin wrapper (optional — coturn/coturn image works)
  turnserver.conf                                # production config

ops/
  deploy.sh                                      # idempotent deployment script
  rotate-secrets.sh                              # secret rotation helper
  README.md                                      # deployment runbook

scripts/
  turn-load-test.mjs                             # script to verify TURN throughput / quota
  health-report.mjs                              # cron-friendly health → MRD-API reporter

.github/workflows/
  build-sharer.yml                               # CI: build Tauri binaries (Linux + Windows)
  release.yml                                    # CI: cut releases on tags

viewer/src/turn-config.ts                        # new — fetch credentials, configure ICE
sharer/src-tauri/src/turn_config.rs              # new — same on the Rust side
```

---

## Task 1: Backend — TURN Credentials Endpoint (TDD)

**Files:**
- Create: `backend/src/turn-credentials.ts`, `backend/tests/turn-credentials.test.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { createServer } from "../src/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.TURN_SHARED_SECRET = "test-secret-32-chars-minimum";
  process.env.TURN_REALM = "turn.screenie.local";
  process.env.TURN_HOSTS = "turn.screenie.local:3478,turns:turn.screenie.local:5349";
  app = await createServer({ port: 0, host: "127.0.0.1" });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => { await app.close(); });

describe("POST /turn-credentials", () => {
  it("returns ephemeral credentials with TURN URLs", async () => {
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error();
    const res = await fetch(`http://127.0.0.1:${addr.port}/turn-credentials`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { urls: string[]; username: string; credential: string; ttl: number };
    expect(body.urls).toContain("turn:turn.screenie.local:3478");
    expect(body.username).toMatch(/^\d+:[a-z0-9-]+$/);
    expect(body.credential).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.ttl).toBeGreaterThan(60);
  });

  it("username encodes the unix timestamp + identifier", async () => {
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error();
    const before = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${addr.port}/turn-credentials`, { method: "POST" });
    const body = await res.json() as { username: string; ttl: number };
    const [tsStr] = body.username.split(":");
    const ts = Number(tsStr);
    expect(ts).toBeGreaterThanOrEqual(before + body.ttl - 5);
    expect(ts).toBeLessThanOrEqual(before + body.ttl + 5);
  });

  it("credential is HMAC-SHA1(secret, username) base64", async () => {
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error();
    const res = await fetch(`http://127.0.0.1:${addr.port}/turn-credentials`, { method: "POST" });
    const body = await res.json() as { username: string; credential: string };
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha1", "test-secret-32-chars-minimum").update(body.username).digest("base64");
    expect(body.credential).toBe(expected);
  });

  it("rate-limits to 10 requests per minute per IP", async () => {
    // ... 11 sequential POSTs, expect status 429 from #11
  });
});
```

- [ ] **Step 2: Implementation**

`turn-credentials.ts`:

```ts
import { randomUUID, createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

export type TurnConfig = {
  sharedSecret: string;
  realm: string;
  urls: string[];
  ttlSec: number;
};

export function makeCredentials(cfg: TurnConfig): {
  urls: string[]; username: string; credential: string; ttl: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + cfg.ttlSec;
  const username = `${expiresAt}:${randomUUID()}`;
  const credential = createHmac("sha1", cfg.sharedSecret).update(username).digest("base64");
  return { urls: cfg.urls, username, credential, ttl: cfg.ttlSec };
}

export function registerTurnEndpoint(app: FastifyInstance, cfg: TurnConfig): void {
  app.post("/turn-credentials", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async () => makeCredentials(cfg));
}
```

Wire in `server.ts`: read env vars (`TURN_SHARED_SECRET`, `TURN_REALM`, `TURN_HOSTS`, `TURN_TTL_SEC`). If `TURN_SHARED_SECRET` is unset → log warning and skip endpoint registration (dev mode without TURN).

- [ ] **Step 3: Register @fastify/rate-limit globally if not already, with per-route override**

- [ ] **Step 4: Tests pass, coverage ≥ 70% for the new module. Commit.**

```bash
git commit -m "feat(backend): POST /turn-credentials with HMAC ephemeral creds"
```

---

## Task 2: Backend — Production Logging + Healthz

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Differentiate dev vs prod log level via `NODE_ENV`**

Pino: dev → `level: "debug"` with pretty-print (via `pino-pretty`, dev-only dep), prod → `level: "info"`, JSON output. Already JSON in prod by default — just gate the prettify.

- [ ] **Step 2: Extend `/healthz` to expose minimal status**

```ts
app.get("/healthz", async () => ({
  status: "ok",
  version: process.env.APP_VERSION ?? "dev",
  uptime: Math.floor(process.uptime()),
}));
```

- [ ] **Step 3: Add `/readyz` for orchestrator probes**

Same as healthz today. Differentiated later if we add deeper readiness checks.

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(backend): production-grade logging and health/readiness endpoints"
```

---

## Task 3: Viewer — Fetch TURN Credentials Before Connect

**Files:**
- Create: `viewer/src/turn-config.ts`
- Modify: `viewer/src/ui.ts`, `viewer/src/webrtc-client.ts`

- [ ] **Step 1: Fetch helper**

```ts
export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export async function fetchIceServers(backendHttpUrl: string): Promise<IceServer[]> {
  const stunOnly: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const res = await fetch(`${backendHttpUrl}/turn-credentials`, { method: "POST" });
    if (!res.ok) return stunOnly;
    const body = await res.json() as { urls: string[]; username: string; credential: string };
    return [
      ...body.urls.map((u) => ({ urls: u, username: body.username, credential: body.credential })),
      ...stunOnly,
    ];
  } catch {
    return stunOnly;
  }
}
```

Replace the public Google STUN fallback with our own STUN (coturn also serves STUN). Plan-level note: keep Google as last-resort fallback for now; remove once self-STUN is reliable. **TODO removed** — make this configurable via `VITE_FALLBACK_STUN` env, default empty (no third-party).

- [ ] **Step 2: Pass iceServers into ViewerPeer**

Modify `ViewerPeer` constructor to accept `iceServers` and forward to `RTCPeerConnection` config (already supports this — verify).

In `ui.ts`, before `new ViewerPeer()`: `const iceServers = await fetchIceServers(backendHttpUrl);`.

- [ ] **Step 3: Tests**

Unit tests for `fetchIceServers`:
- Returns merged TURN + STUN array when endpoint returns 200
- Returns just fallback STUN when endpoint returns 4xx/5xx or unreachable
- Doesn't throw on network error

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(viewer): fetch TURN credentials and configure ICE servers"
```

---

## Task 4: Sharer — Fetch TURN Credentials (Rust)

**Files:**
- Create: `sharer/src-tauri/src/turn_config.rs`
- Modify: `sharer/src-tauri/src/lib.rs`, `sharer/src-tauri/Cargo.toml` (add `reqwest`)

- [ ] **Step 1: Add `reqwest` (rustls-only, no openssl) exact-pinned**

```toml
reqwest = { version = "=X.Y.Z", default-features = false, features = ["rustls-tls", "json"] }
```

- [ ] **Step 2: Implementation**

```rust
#[derive(Deserialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u32,
}

pub async fn fetch_ice_servers(backend_http_url: &str) -> Vec<RTCIceServer> {
    let mut servers = vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".into()],
        ..Default::default()
    }];
    let url = format!("{backend_http_url}/turn-credentials");
    let Ok(resp) = reqwest::Client::new().post(&url).send().await else { return servers };
    if !resp.status().is_success() { return servers; }
    let Ok(creds): Result<TurnCredentials, _> = resp.json().await else { return servers };
    for turn_url in creds.urls {
        servers.insert(0, RTCIceServer {
            urls: vec![turn_url],
            username: creds.username.clone(),
            credential: creds.credential.clone(),
            credential_type: webrtc::ice_transport::ice_credential_type::RTCIceCredentialType::Password,
        });
    }
    servers
}
```

- [ ] **Step 3: Use in `lib.rs` before creating SharerPeer.**

- [ ] **Step 4: Rust unit tests for parsing the TurnCredentials JSON.**

- [ ] **Step 5: Build clean. Commit.**

```bash
git commit -m "feat(sharer): fetch TURN credentials at session start"
```

---

## Task 5: Telemetry — P2P vs TURN Detection

**Files:**
- Modify: `viewer/src/webrtc-client.ts`, `viewer/src/ui.ts`
- Modify: `sharer/src-tauri/src/webrtc.rs`, `sharer/src-tauri/src/lib.rs`

- [ ] **Step 1: Detect on viewer side**

After ICE connects, query `pc.getStats()` and find the active candidate pair. Check `localCandidate.candidateType` and `remoteCandidate.candidateType`. If either is `relay` → connection is via TURN.

Emit a callback: `peer.onConnectionType((type: "p2p" | "relay") => void)`.

- [ ] **Step 2: UI hint**

Small badge in the viewer near the disconnect button: "Direkt" (P2P) or "Über Relay" (TURN), neutral styling.

- [ ] **Step 3: Sharer side: same detection, but on the Rust side via `webrtc::stats`**

Push the type to the webview via a Tauri event; webview displays it in the floating panel.

- [ ] **Step 4: Tests** for the viewer's stats-parsing logic (mock `getStats()`).

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(both): detect and display P2P vs TURN connection type"
```

---

## Task 6: Free-Tier Limit UX — Warning + Cutoff

**Files:**
- Modify: `viewer/src/ui.ts`
- Modify: `sharer/src-tauri/src/lib.rs`

- [ ] **Step 1: Viewer-side timer**

When `peer.onConnectionType` reports `"relay"`, start a timer:
- At minute 8: show a toast "Noch 2 Min Relay-Zeit übrig — Premium ab €X/Monat".
- At minute 10: optimistically tear down with a friendly upgrade screen (don't wait for coturn to cut — display first, then let the underlying cut close the session).

The actual cutoff is enforced by coturn (`lifetime=600`). The viewer UX is just a pre-warning + friendlier replacement screen.

- [ ] **Step 2: Sharer-side mirror**

Sharer's floating panel shows the same countdown.

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(both): free-tier warning + soft upgrade prompt"
```

---

## Task 7: coturn Container

**Files:**
- Create: `coturn/turnserver.conf`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: `coturn/turnserver.conf`**

```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=${TURN_SHARED_SECRET}
realm=turn.screenie.mr-development.de
total-quota=100
user-quota=5000000
max-bps=5000000
lifetime=600
no-multicast-peers
no-tlsv1
no-tlsv1_1
cert=/etc/letsencrypt/live/turn.screenie.mr-development.de/fullchain.pem
pkey=/etc/letsencrypt/live/turn.screenie.mr-development.de/privkey.pem
log-file=stdout
verbose
```

- [ ] **Step 2: Service in `docker-compose.prod.yml`**

```yaml
coturn:
  image: coturn/coturn:4.6.3-alpine
  container_name: screenie-coturn
  restart: unless-stopped
  network_mode: host                            # required for proper NAT traversal
  volumes:
    - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
    - letsencrypt:/etc/letsencrypt:ro
  command: ["-c", "/etc/coturn/turnserver.conf"]
  environment:
    TURN_SHARED_SECRET: ${TURN_SHARED_SECRET}
```

Note: `coturn` works best with `network_mode: host` because TURN allocates UDP ports dynamically and Docker port mapping for UDP-port-ranges is awkward. Document this trade-off in the deployment runbook.

- [ ] **Step 3: Smoke test locally**

```
docker compose -f docker-compose.prod.yml up coturn
turnutils_uclient -t -u 9999:test -w $(echo -n "9999:test" | openssl dgst -sha1 -hmac "$TURN_SHARED_SECRET" -binary | base64) -p 3478 127.0.0.1
```

(Adjust username/credential per coturn auth-secret rules.)

- [ ] **Step 4: Commit.**

---

## Task 8: Caddy Reverse Proxy (Backend + Viewer)

**Files:**
- Create: `caddy/Caddyfile`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: `caddy/Caddyfile`**

```
{
    email m.roedig@gmail.com
}

screenie.mr-development.de {
    encode zstd gzip

    # Static viewer
    handle_path /assets/* {
        root * /srv/viewer/assets
        file_server
    }
    handle / {
        root * /srv/viewer
        file_server
        try_files {path} /index.html
    }

    # Backend API + WebSocket signaling
    handle /signal {
        reverse_proxy backend:8080
    }
    handle /turn-credentials {
        reverse_proxy backend:8080
    }
    handle /healthz {
        reverse_proxy backend:8080
    }
    handle /readyz {
        reverse_proxy backend:8080
    }
}
```

- [ ] **Step 2: Compose service**

```yaml
caddy:
  image: caddy:2.10-alpine
  container_name: screenie-caddy
  restart: unless-stopped
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
    - viewer-static:/srv/viewer:ro
    - caddy-data:/data
    - caddy-config:/config
    - letsencrypt:/etc/letsencrypt          # shared cert volume with coturn
  depends_on:
    - backend
```

- [ ] **Step 3: Viewer build → static volume**

Add a one-shot service that builds the viewer and writes to `viewer-static`:

```yaml
viewer-build:
  image: node:22-alpine
  working_dir: /viewer
  volumes:
    - ./viewer:/viewer:ro
    - viewer-static:/dist
  command: sh -c "cp -r /viewer /tmp/viewer && cd /tmp/viewer && npm ci && npm run build && cp -r dist/. /dist/"
  restart: "no"
```

(Actually run this as a CI step + sync the result to `viewer-static`; the one-shot in compose is a fallback.)

- [ ] **Step 4: Commit.**

---

## Task 9: Production Compose — Backend + Caddy + coturn + (optional) Postgres

**Files:**
- Finalize: `docker-compose.prod.yml`
- Create: `.env.prod.example`

- [ ] **Step 1: Full `docker-compose.prod.yml`**

```yaml
volumes:
  caddy-data:
  caddy-config:
  viewer-static:
  letsencrypt:
  postgres-data:                                  # only used in Task 10

services:
  backend:
    image: ghcr.io/m-roedig/screenie-backend:${APP_VERSION:-latest}    # pushed by CI
    container_name: screenie-backend
    restart: unless-stopped
    env_file: [.env.prod]
    expose:
      - "8080"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3

  caddy:
    # … as above
  coturn:
    # … as above
```

- [ ] **Step 2: `.env.prod.example`**

```
APP_VERSION=
TURN_SHARED_SECRET=         # generate with: openssl rand -hex 32
TURN_REALM=turn.screenie.mr-development.de
TURN_HOSTS=turn:turn.screenie.mr-development.de:3478,turns:turn.screenie.mr-development.de:5349
TURN_TTL_SEC=3600
SESSION_TTL_MS=600000
MAX_FAILED_ATTEMPTS=5
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=5
ALLOWED_ORIGINS=https://screenie.mr-development.de
NODE_ENV=production
APP_VERSION=
```

- [ ] **Step 3: Commit.**

---

## Task 10: (Optional) Postgres for Premium Hook

**Files:**
- Modify: `docker-compose.prod.yml`
- Create: `backend/migrations/001_premium_keys.sql`
- Modify: `backend/src/turn-credentials.ts`

- [ ] **Step 1: Schema**

```sql
CREATE TABLE premium_keys (
  api_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX premium_keys_expires_at ON premium_keys (expires_at);
```

- [ ] **Step 2: Optional `?key=` parameter on `/turn-credentials`**

If the key exists in Postgres AND is not expired, generate credentials with a longer TTL (e.g. 8 hours). This bypasses the free-tier `lifetime=600` because the username encodes a later timestamp; coturn honours the timestamp.

Implementation only enabled if `DATABASE_URL` env var is set. Default (MVP): not connected. Premium flow is just the schema + endpoint hook for later integration with the MRD Stripe-driven account system.

- [ ] **Step 3: Add Postgres service to `docker-compose.prod.yml`**

```yaml
postgres:
  image: postgres:17.5-alpine
  container_name: screenie-postgres
  restart: unless-stopped
  environment:
    POSTGRES_DB: screenie
    POSTGRES_USER: ${PG_USER:-screenie}
    POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
  secrets:
    - postgres-password
  volumes:
    - postgres-data:/var/lib/postgresql/data

secrets:
  postgres-password:
    file: ./secrets/postgres-password.txt
```

(Use file-based secrets — `secrets/postgres-password.txt` is gitignored.)

- [ ] **Step 4: Commit.**

---

## Task 11: Deployment Runbook + Scripts

**Files:**
- Create: `ops/deploy.sh`, `ops/README.md`

- [ ] **Step 1: `ops/deploy.sh`** — idempotent script that:
1. SSHes to VPS (target derived from MRD cluster config)
2. Pulls latest images (`docker compose -f docker-compose.prod.yml pull`)
3. Restarts services with zero-downtime where possible (`docker compose up -d`)
4. Verifies `/healthz` returns 200 within 60s
5. Reports status to MRD-API (`POST /clusters/.../status`)

- [ ] **Step 2: `ops/README.md`** — runbook covering:
- One-time setup (DNS A records, `secrets/` files, first `caddy` Let's Encrypt request)
- Routine deploy (run `deploy.sh`)
- Rollback (`docker compose up -d --force-recreate backend@previous-tag`)
- Cert renewal (Caddy is automatic; coturn shares the volume)
- Common failure modes (DNS propagation, port conflicts, coturn certificate refresh)

- [ ] **Step 3: Commit.**

```bash
git commit -m "ops: production deployment script and runbook"
```

---

## Task 12: CI/CD — Build + Release Tauri Binaries

**Files:**
- Create: `.github/workflows/build-sharer.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: `build-sharer.yml`** runs on `main` push and PRs:
- Matrix: `ubuntu-latest`, `windows-latest`
- Installs Rust + Node, runs `cd sharer && npm ci && npm run tauri:build`
- Uploads artefact

- [ ] **Step 2: `release.yml`** runs on tag `v*`:
- Same matrix
- Creates GitHub Release
- Attaches binaries
- Builds + pushes `screenie-backend` Docker image to GHCR with the tag

- [ ] **Step 3: Commit.**

---

## Task 13: Smoke-Test Production Setup Locally

Run `docker-compose.prod.yml` end-to-end on the dev box with mock DNS (edit `/etc/hosts` to point `screenie.mr-development.de` at `127.0.0.1`). Caddy will fail to get a real cert but you can use its `internal` directive temporarily, or skip TLS and use HTTP for the smoke test.

- Verify `/healthz` reachable through Caddy
- Verify viewer loads at `https://screenie.mr-development.de/` (or `http://localhost`)
- Verify TURN credentials endpoint returns valid JSON
- Manual: open viewer in browser, run mock-sharer pointing at the same backend, verify connection works through Caddy

Commit a `docs/smoke-test-prod.md` runbook with the procedure.

---

## Task 14: Real Deployment

- [ ] **DNS:** add A-records `screenie.mr-development.de` and `turn.screenie.mr-development.de` pointing to VPS IP (managed via your DNS provider).
- [ ] **VPS prep (one-time):** install Docker, create deploy user, install `git`.
- [ ] **First deploy:**
  ```
  ssh deploy@VPS
  git clone <repo>
  cd screenshare
  cp .env.prod.example .env.prod && edit
  echo '<random>' > secrets/postgres-password.txt
  docker compose -f docker-compose.prod.yml up -d
  ```
- [ ] **Verify:** `curl -fsS https://screenie.mr-development.de/healthz` → 200, TURN reachable from external network.
- [ ] **MRD-API status:** `POST /clusters/.../status` with `state: "operational"`.

This task is manual — produces an entry in the project's MRD status, not a code commit.

---

## Task 15: TURN Traffic Reporting

**Files:**
- Create: `scripts/health-report.mjs`, `scripts/turn-traffic-report.mjs`

- [ ] **Step 1: TURN traffic report**

coturn logs include `n2 -- s2 bytes` per session. A nightly cron parses the previous day's coturn logs (mounted as a volume), sums bytes, posts to MRD-API (`POST /clusters/.../status` with payload `{ turn_gb_24h: N }`).

Use the existing `mrd-context.sh` and MRD-API contract.

- [ ] **Step 2: Cron setup**

systemd-timer on the VPS calls the script daily at 02:00 UTC.

- [ ] **Step 3: Commit.**

```bash
git commit -m "feat(ops): daily TURN traffic reporting to MRD-API"
```

---

## Phase 4 — Done When

- `https://screenie.mr-development.de/` serves the viewer (TLS via Let's Encrypt)
- `wss://screenie.mr-development.de/signal` connects from a real browser
- `POST https://screenie.mr-development.de/turn-credentials` returns valid TURN credentials
- TURN reachable from external Internet: `turnutils_uclient -t -u <user> -w <cred> turn.screenie.mr-development.de` succeeds
- A real-world connection from a restricted network (mobile tethering with symmetric NAT) successfully establishes via TURN, observed via the "Über Relay" indicator
- Lifetime-cut after 10 minutes triggers the free-tier upgrade prompt cleanly
- `/healthz` and `/readyz` reachable through Caddy; CI pings them post-deploy
- TURN traffic reporting cron emits daily to MRD-API; first report visible in MRD-Dashboard
- Tauri binaries (Linux + Windows) build in CI and are attached to GitHub Releases

## Out of Scope (still — really)

- Audio
- Recording
- Mobile sharer apps
- Account system (Premium hook prepared, real flow lives in MRD)
- macOS Code-Signing certificate (paid)
- Wayland-native screen capture (X11/XWayland only)
