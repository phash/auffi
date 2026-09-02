# Auffi — Production Deployment Runbook

Target VPS: `musikersuche@musikersuche.org` (`/opt/screenie` — path retained
post-rebrand for Docker volume / cert continuity; see CLAUDE.md).
Main domain: `auffi.app`
TURN domain: `turn.auffi.app`

---

## 1. Prerequisites

### On your local machine
- **SSH access**: `ssh musikersuche@musikersuche.org` works without password prompts (key in `~/.ssh/config` or `~/.ssh/authorized_keys` on the VPS).
- **Pinned host key**: every ops script connects with `StrictHostKeyChecking=yes` against the committed `ops/known_hosts` (never trust-on-first-use — a fresh workstation or CI runner under a DNS hijack would otherwise ship the image and `.env.prod` edits to the attacker). The file holds the `musikersuche.org` keys (ED25519 `SHA256:n/+JFpPKyxpCVthkkccPgPAyblkG8qMn6E1XvjcMBdY`). **Self-hosters**: replace it with `ssh-keyscan -t ed25519,rsa,ecdsa <your-host> > ops/known_hosts` and compare the fingerprint (`ssh-keygen -l -f ops/known_hosts`) against what your provider's console shows — or set `DEPLOY_KNOWN_HOSTS=/path/to/file` in `ops/.env.deploy`. **Key rotation on the VPS**: regenerate the file the same way and commit it; until then every script fails fast with `Host key verification failed`, which is the intended behaviour.
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
| A | `auffi.app` | VPS IPv4 |
| A | `turn.auffi.app` | VPS IPv4 |

Caddy obtains the Let's Encrypt certificate for `auffi.app` automatically on first startup (HTTP-01 challenge). The TURN cert must be provisioned separately — see [TLS for coturn](#tls-for-coturn) below.

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

# Copy production env template to the VPS and fill it in. deploy.sh refuses
# to bring the stack up while .env.prod is missing (it places the example
# file for you and stops), so do this before the first deploy.
scp .env.prod.example musikersuche@musikersuche.org:/opt/screenie/.env.prod
ssh musikersuche@musikersuche.org
  $EDITOR /opt/screenie/.env.prod   # fill in TURN_SHARED_SECRET, APP_VERSION, etc.
  exit

# Generate a TURN shared secret (if you don't have one yet):
openssl rand -hex 32
```

### SMTP (gh #39 — required for unattended-mode accounts)

The dashboard's account flows (signup → verify-email, forgot-password
→ reset, change-email confirmation) all send outbound mail through
nodemailer. If `SMTP_*` is unset, the backend falls back to an
in-memory capture transport — signups succeed but nothing is
delivered. **For production: set SMTP_HOST + creds in `.env.prod`
BEFORE inviting users**, otherwise verify links never arrive.

Recommended providers (TLS-on-587, app-passwords supported):
mailbox.org, Fastmail, SendGrid. Generate an app-specific password
on the provider — don't paste a personal mailbox login.

Fill in `.env.prod` (the example file ships with stub keys + the
deliverability matrix as comments):

```sh
SMTP_HOST=smtp.mailbox.org
SMTP_PORT=587
SMTP_USER=noreply@yourdomain
SMTP_PASS=<app-password>
SMTP_FROM=noreply@yourdomain
DASHBOARD_URL=https://auffi.app/dashboard
```

Smoke-test from the VPS after first deploy:

```sh
ssh musikersuche@musikersuche.org
docker compose -f /opt/screenie/docker-compose.prod.yml exec backend \
  node -e 'require("./dist/email/mailer.js").mailerFromEnv().transport.send({
    to: "you@your-mailbox", subject: "auffi smtp test", text: "ok"
  }).then(()=>console.log("sent")).catch(e=>console.error(e))'
```

If the test mail doesn't arrive: check the backend container log for
`verify-email send failed` / `reset-email send failed` warnings. The
backend never crashes on SMTP failure — it just drops the mail.

#### Initial admin

To grant `/api/admin/*` access to your own account: sign up via the
dashboard FIRST (so the row exists), then set `INITIAL_ADMIN_EMAIL`
in `.env.prod` and restart the backend. `bootstrapInitialAdmin()`
runs on every boot and idempotently flips the admin flag on the
matching account. Unset to keep every account non-admin.

```sh
INITIAL_ADMIN_EMAIL=admin@yourdomain
```

#### Closing public signups (single-tenant self-host)

A typical self-host wants exactly one account — yours. After you have
signed up and promoted yourself to admin (above), close the door:

```sh
SIGNUP_DISABLED=1
```

`POST /api/auth/signup` then returns `403 signup-disabled`; login and
password-reset stay open, so your account keeps working. Restart the
backend to apply. Leave the var unset/empty to keep signups open.

#### Backing up the account database

Accounts, devices, sessions and connection logs live in a single
SQLite file at `/var/lib/auffi/auffi.db` inside the backend's data
volume. The canonical, scheduled approach is `ops/backup.sh` — it takes
a consistent online snapshot via better-sqlite3's `.backup()` API,
gzips it, prunes old copies, and can rsync off-host. Wire it into cron:

```sh
0 3 * * * /opt/screenie/ops/backup.sh >> /opt/backup/auffi/backup.log 2>&1
```

For a one-off manual backup without the script, either run `ops/backup.sh`
directly, or stop the backend, copy `auffi.db` out of the volume, and
start it again (cold copy). Full restore steps are in
`docs/ops-runbook.md` § Daily Backup + Restore.

### TLS for coturn

Caddy handles its own cert (auffi.app) automatically. For the TURN subdomain
(`turn.auffi.app`) coturn needs a separate cert. coturn
(`coturn/entrypoint.sh` + `turnserver.conf.tmpl`) reads FLAT files
`cert.pem` + `key.pem` from the volume mounted at `/var/lib/turn`; a missing
pair is non-fatal (TURNS on 5349 is disabled, plain TURN on 3478 keeps
working — which is exactly how an expired cert hides for weeks). Which path
applies depends on the deployment mode:

**Cluster mode (current prod) — Caddy certificate export via the
`turn-cert-stage` sidecar. Nothing to install.**

`docker-compose.cluster.yml` runs a one-shot `turn-cert-stage` container on
every `docker compose up`: it copies `turn.auffi.app.crt/.key` out of the
cluster Caddy's data volume (`caddyserver_caddy_data`) into the
`turn-certs-staged` volume that coturn mounts. Prerequisite: the cluster
Caddyfile has a site block for `turn.auffi.app` so Caddy obtains and renews
the cert. A renewal reaches coturn on the next deploy or
`./ops/maintenance.sh restart coturn` (coturn reads the cert at startup) —
`./ops/maintenance.sh cert-info` shows what 5349 currently presents.

**Standalone mode — certbot on the host.**

Our own `auffi-caddy` owns :80/:443, so certbot's `--standalone`
authenticator cannot bind :80: `certbot renew --quiet` fails silently every
night and the TURNS cert expires after 90 days. Stop Caddy around the
challenge (a few seconds of downtime) and do not silence the output:

```sh
ssh <your-host>
sudo apt install certbot
sudo certbot certonly --standalone \
  -d turn.<your-domain> \
  -m <your-mail> \
  --agree-tos --non-interactive \
  --pre-hook 'docker stop auffi-caddy' --post-hook 'docker start auffi-caddy'
# Stage the flat cert pair into the Docker volume. certbot's live/ paths are
# symlinks into archive/ — mount all of /etc/letsencrypt and resolve them
# with cp -L. The volume name carries the compose project prefix (screenie_
# on prod, DEPLOY_PATH=/opt/screenie, see CLAUDE.md rebrand notes) — a wrong
# prefix is silently auto-created as a fresh empty volume coturn never reads.
docker run --rm \
  -v /etc/letsencrypt:/src:ro \
  -v screenie_turn-certs:/dst \
  busybox:1.36.1 sh -c 'cp -L /src/live/turn.<your-domain>/fullchain.pem /dst/cert.pem \
    && cp -L /src/live/turn.<your-domain>/privkey.pem /dst/key.pem \
    && chmod 644 /dst/cert.pem /dst/key.pem'
```

Auto-renewal — the hooks stop/start Caddy only when a renewal is actually
due, and the run is logged so a failure is visible:
```sh
echo '0 3 * * * root certbot renew \
    --pre-hook "docker stop auffi-caddy" --post-hook "docker start auffi-caddy" \
    --deploy-hook "docker run --rm -v /etc/letsencrypt:/src:ro -v screenie_turn-certs:/dst \
      busybox:1.36.1 sh -c \"cp -L /src/live/turn.<your-domain>/fullchain.pem /dst/cert.pem \
      && cp -L /src/live/turn.<your-domain>/privkey.pem /dst/key.pem \
      && chmod 644 /dst/cert.pem /dst/key.pem\" \
      && docker compose -f /opt/screenie/docker-compose.prod.yml restart coturn" \
    >> /var/log/certbot-auffi.log 2>&1' \
  | sudo tee /etc/cron.d/certbot-auffi
```

If your DNS provider has a certbot plugin, `--preferred-challenges dns` avoids
the Caddy stop/start entirely.

---

## 3. First Deploy

```sh
# From your local machine, inside the repo root:
./ops/deploy.sh
```

`deploy.sh` will:
1. Verify the working tree is clean (`--allow-dirty` to override — the
   image tag is the git SHA), SSH and Docker are reachable on the VPS, and
   `.env.prod` exists there. **If `.env.prod` is missing the deploy stops
   here**: it places `.env.prod.example` as `.env.prod` on the VPS and tells
   you to fill in `TURN_SHARED_SECRET`, `ALLOWED_ORIGINS` and `SMTP_*`
   before re-running (an unconfigured stack would come up "healthy" with a
   restart-looping coturn and no mail).
2. Build `auffi-backend:<git-sha>` locally.
3. Build `viewer/dist/` AND `dashboard/dist/` locally (gh #38).
4. rsync compose files, nginx + coturn config, viewer dist, and the
   dashboard dist into `dashboard-dist/` on the VPS. The Caddyfile is
   shipped **only in standalone mode** — on the cluster host (current prod,
   `CLUSTER_PROXY` set) `/opt/caddyserver/Caddyfile` is hand-maintained,
   see the snippet below and `docs/footguns.md` § Cluster-Ops.
5. Load the backend image on the VPS.
6. Pin `APP_VERSION` in `.env.prod` to the deployed SHA.
7. Run `docker compose up -d`.
8. Wait up to 90 seconds for `/healthz` to return 200.
9. Print `docker compose ps`.

### Cluster-mode Caddy snippet (gh #38)

When running behind a shared cluster Caddy at
`/opt/caddyserver/Caddyfile`, the site block for `auffi.app` needs
the same `/dashboard/*` + `/api/*` routes that our standalone
`caddy/Caddyfile` ships. Copy-paste the new `handle /api/* { ... }`
and `handle_path /dashboard/* { ... }` blocks into the cluster
Caddyfile, then validate and **restart** the proxy — the cluster Caddyfile
runs with `admin off`, so `caddy reload` fails with `connection refused` on
the admin port 2019 and leaves the old config live:

```sh
docker exec caddy-proxy caddy validate --config /etc/caddy/Caddyfile \
  && docker restart caddy-proxy   # ~3 s connection blip for all tenants
```

Preview without executing anything:
```sh
./ops/deploy.sh --dry-run
```

---

## 4. Routine Update

```sh
./ops/deploy.sh
```

`deploy.sh` is the canonical path for routine updates too — it is idempotent
and skips unchanged builds itself (image build is skipped when the tag
already exists on prod, `npm ci` when the lockfile is unchanged), takes the
deploy lock, and appends to the deploy-log that the diff preview, image
prune, and rollback rely on.

`ops/update.sh` still exists as a minimal backend+viewer-only hotfix
path, but it bypasses the deploy lock and the deploy-log — see the
warning header in the script before using it.

---

## 5. Rollback

```sh
./ops/deploy.sh --rollback
```

Reads the previous SHA from the deploy-log on the VPS (falling back to the
last logged entry when the most recent deploy failed before being logged),
sets `APP_VERSION` in `.env.prod`, restores that SHA's **release snapshot**
(`/opt/screenie/releases/<sha>/` — `viewer-dist`, `dashboard-dist`, `nginx/`,
`coturn/`, in standalone mode also `caddy/`), recreates the stack, restarts
the sidecars that read those files through single-file bind mounts
(`auffi-dashboard`, `auffi-coturn`, cluster: `auffi-viewer`, standalone:
`auffi-caddy`), and runs the same smoke checks as a deploy. Every successful
deploy writes its snapshot after the health checks pass; the prune step keeps
images and snapshots for the same last 3 SHAs, so the rollback target is
still loaded.

**Without a snapshot** (a SHA deployed before 0.7.1) the rollback is
backend-image-only — the script says so loudly, and the frontends/configs stay
at the newer state. To back out a frontend/config regression in that case,
check out the old commit and run `./ops/deploy.sh --version <sha>`.

`ops/update.sh` (hotfix path) bypasses the deploy-log AND the snapshots: a
hotfixed viewer-dist is not restorable via `--rollback`.

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
dig +short auffi.app
nslookup auffi.app 8.8.8.8
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
ls -t /opt/screenie/auffi-backend-*.tar.gz | tail -n +4 | xargs -r rm
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
