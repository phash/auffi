# Screenie — Production Deployment Runbook

Target VPS: `musikersuche@musikersuche.org` (`/opt/screenie`)
Main domain: `screenie.mr-development.de`
TURN domain: `turn.screenie.mr-development.de`

---

## 1. Prerequisites

### On your local machine
- **SSH access**: `ssh musikersuche@musikersuche.org` works without password prompts (key in `~/.ssh/config` or `~/.ssh/authorized_keys` on the VPS).
- **Docker Desktop or Docker Engine** installed and running.
- **Node.js 22** for building the viewer locally.
- **openssl** (present on every macOS/Linux machine by default).
- **rsync** (standard on Linux/macOS).
- **curl** for health checks.

### On the VPS (one-time setup)
- Docker Engine installed (`apt install docker.io` or use the official Docker installer).
- `docker compose` v2 available (`docker compose version` returns 2.x).
- Ports 80, 443, 3478, 5349, and the TURN UDP range (49152-65535) open in the firewall.

### DNS records (must be live before first deploy)
| Record type | Name | Value |
|-------------|------|-------|
| A | `screenie.mr-development.de` | VPS IPv4 |
| A | `turn.screenie.mr-development.de` | VPS IPv4 |

Caddy obtains the Let's Encrypt certificate for `screenie.mr-development.de` automatically on first startup (HTTP-01 challenge). The TURN cert must be provisioned separately — see [TLS for coturn](#tls-for-coturn) below.

---

## 2. One-Time Setup

```sh
# Clone and enter the repo
git clone <repo-url> ~/screenshare
cd ~/screenshare

# Copy deploy configuration
cp ops/.env.deploy.example ops/.env.deploy
# Edit ops/.env.deploy — set DEPLOY_SSH, DEPLOY_PATH, DEPLOY_DOMAIN, etc.
$EDITOR ops/.env.deploy

# Copy production env template to the VPS (deploy.sh does this, but do it now
# so you can set secrets before the first deploy)
scp .env.prod.example musikersuche@musikersuche.org:/opt/screenie/.env.prod
ssh musikersuche@musikersuche.org
  $EDITOR /opt/screenie/.env.prod   # fill in TURN_SHARED_SECRET, APP_VERSION, etc.
  exit

# Generate a TURN shared secret (if you don't have one yet):
openssl rand -hex 32
```

### TLS for coturn

Caddy handles its own cert (screenie.mr-development.de) automatically. For the TURN subdomain (`turn.screenie.mr-development.de`) coturn needs a separate cert. Two approaches:

**Approach A — certbot on the host (recommended for simplicity)**

```sh
ssh musikersuche@musikersuche.org
sudo apt install certbot
sudo certbot certonly --standalone \
  -d turn.screenie.mr-development.de \
  -m m.roedig@gmail.com \
  --agree-tos --non-interactive
# certbot writes to /etc/letsencrypt — populate the Docker volume:
docker run --rm \
  -v /etc/letsencrypt:/src:ro \
  -v screenshare_turn-certs:/dst \
  busybox sh -c 'cp -a /src/. /dst/'
```

Set up certbot auto-renewal:
```sh
echo '0 3 * * * root certbot renew --quiet && \
  docker run --rm \
    -v /etc/letsencrypt:/src:ro \
    -v screenshare_turn-certs:/dst \
    busybox sh -c "cp -a /src/. /dst/" && \
  docker compose -f /opt/screenie/docker-compose.prod.yml restart coturn' \
  | sudo tee /etc/cron.d/certbot-screenie
```

**Approach B — Caddy certificate export (deferred)**

Caddy 2 stores ACME certs in the `caddy-data` volume under `/data/caddy/certificates/`. To share this with coturn, you would mount `caddy-data` read-only into the coturn container and adjust the cert/pkey paths in `turnserver.conf.tmpl`. This is viable but requires knowing Caddy's internal path layout (`/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<domain>/<domain>.crt`). Left as a future simplification; Approach A is cleaner.

---

## 3. First Deploy

```sh
# From your local machine, inside the repo root:
./ops/deploy.sh
```

`deploy.sh` will:
1. Verify SSH and Docker are reachable on the VPS.
2. Build `screenie-backend:<git-sha>` locally.
3. Build `viewer/dist/` locally.
4. rsync compose files, Caddyfile, coturn config, and viewer dist.
5. Load the backend image on the VPS.
6. Place `.env.prod.example` on the VPS if `.env.prod` is absent.
7. Run `docker compose up -d`.
8. Wait up to 90 seconds for `/healthz` to return 200.
9. Print `docker compose ps`.

Preview without executing anything:
```sh
./ops/deploy.sh --dry-run
```

---

## 4. Routine Update

```sh
./ops/update.sh
```

Builds and transfers only the backend image and viewer dist, then restarts only the backend container. Caddy and coturn are untouched. Auto-rolls back to the previous image if the health check fails within 60 seconds.

---

## 5. Rollback

```sh
./ops/update.sh --rollback
```

Finds the second-most-recent image tarball on the VPS, loads it, sets `APP_VERSION` in `.env.prod`, and restarts the backend. Up to 3 previous tarballs are kept automatically.

---

## 6. Common Operations

```sh
# Container status + recent logs
./ops/maintenance.sh status

# Tail logs for all services (Ctrl+C to stop)
./ops/maintenance.sh logs

# Tail logs for one service
./ops/maintenance.sh logs backend
./ops/maintenance.sh logs caddy
./ops/maintenance.sh logs coturn

# Restart a single service
./ops/maintenance.sh restart backend

# Stop everything (volumes kept)
./ops/maintenance.sh down

# Start everything
./ops/maintenance.sh up

# Shell into a container
./ops/maintenance.sh shell backend

# Show TLS cert expiry dates
./ops/maintenance.sh cert-info

# Backup TURN certs volume
./ops/maintenance.sh backup-certs

# Rotate the TURN shared secret
./ops/maintenance.sh secret-rotate
```

---

## 7. Failure Scenarios

### DNS not yet propagated

**Symptom**: Caddy starts but fails to obtain a Let's Encrypt cert; HTTPS unavailable; ACME challenge fails.

**Fix**: Wait for DNS propagation (usually < 10 min, sometimes up to 48 h). Check with:
```sh
dig +short screenie.mr-development.de
nslookup screenie.mr-development.de 8.8.8.8
```
Once the A-record resolves to the VPS IP, restart Caddy:
```sh
./ops/maintenance.sh restart caddy
```
Caddy retries the ACME challenge automatically.

---

### Port conflict (80/443 already in use)

**Symptom**: `docker compose up` fails with "address already in use".

**Fix**: Find what is using the port and stop it:
```sh
ssh musikersuche@musikersuche.org "sudo ss -tlnp | grep ':80\|:443'"
# Stop the conflicting service, then:
./ops/maintenance.sh up
```

---

### coturn cert refresh

coturn reads the cert at startup. After certbot renews the cert and copies it into the `turn-certs` volume, restart coturn:
```sh
./ops/maintenance.sh restart coturn
```
The cron job in [TLS for coturn](#tls-for-coturn) does this automatically.

---

### Caddy first-time cert delay

On first deploy Caddy may take 30–60 seconds to complete the ACME HTTP-01 challenge. During this time `/healthz` returns a 502 through Caddy (the backend is up, Caddy is still initialising TLS). `deploy.sh` waits 90 seconds total; the delay is normal.

---

### Disk full

**Symptom**: Docker operations fail, containers OOM-killed.

**Fix**:
```sh
ssh musikersuche@musikersuche.org
df -h
docker system prune -f          # remove stopped containers, dangling images
# Remove all but the latest backend image tarballs:
ls -t /opt/screenie/screenie-backend-*.tar.gz | tail -n +4 | xargs -r rm
```

---

### Certs expired

```sh
./ops/maintenance.sh cert-info   # check expiry
```
- Caddy auto-renews its own cert; if it has expired, restart Caddy and check its logs.
- If the TURN cert has expired, run certbot manually and restart coturn.

---

## 8. Secret Rotation

Rotate the TURN shared secret without downtime:
```sh
./ops/maintenance.sh secret-rotate
```
This generates a new 32-byte hex secret, writes it to `.env.prod` on the VPS, and restarts backend + coturn. Active TURN sessions drain naturally (coturn enforces `lifetime=600`).

---

## 9. Health Check Cron

Set up automated health monitoring from the VPS itself:
```sh
ssh musikersuche@musikersuche.org
crontab -e
# Add:
# */5 * * * * /opt/screenie/ops/health-check.sh >> /var/log/screenie-health.log 2>&1
```

For MRD-API reporting, set these additional env vars in `/opt/screenie/.env.prod` (or in the crontab environment):
```
MRD_API_KEY=<your-key>
MRD_CLUSTER_ID=1258842b-b60b-41b8-bf21-0df6f4b21b9d
```

---

## 10. coturn network_mode: host

coturn uses `network_mode: host` in `docker-compose.prod.yml`. This is intentional:

- TURN allocates UDP ports dynamically (default range 49152-65535).
- Docker's port-range mapping (`--publish 49152-65535:49152-65535/udp`) is fragile at this scale and adds latency.
- With `network_mode: host`, coturn binds directly to the host network — exactly as the TURN RFC expects.
- **Trade-off**: coturn ports are visible directly on the host, not namespaced by Docker networking. This is safe because coturn only accepts authenticated connections.
- Caddy and backend remain on the Docker `internal` bridge network and are unaffected.
