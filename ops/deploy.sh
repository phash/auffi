#!/usr/bin/env bash
# ops/deploy.sh — full first-time or update deployment to the VPS.
#
# Usage:
#   ./ops/deploy.sh [--dry-run] [--version <tag>] [--yes]
#   ./ops/deploy.sh --help
#
# Environment:
#   Reads ops/.env.deploy (or env vars) for SSH target and paths.
#   APP_VERSION — override image tag (default: git short SHA)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=ops/lib.sh
source "${SCRIPT_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
YES=false
VERSION=""

print_help() {
  cat <<EOF
Usage: $(basename "$0") [options]

Full idempotent deployment — builds images locally, transfers them to the VPS,
syncs config + viewer dist, starts/updates all services, and waits for health.

Options:
  --dry-run        Print what would happen without executing any remote commands.
  --version <tag>  Image tag to build and deploy (default: git short SHA).
  --yes            Skip interactive confirmation prompts.
  --help           Show this help and exit.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true ;;
    --yes)      YES=true ;;
    --version)  VERSION="$2"; shift ;;
    --help)     print_help; exit 0 ;;
    *)          log_error "Unknown option: $1"; print_help; exit 1 ;;
  esac
  shift
done

load_deploy_env

# Resolve image version
if [[ -z "${VERSION}" ]]; then
  VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "latest")"
fi
export APP_VERSION="${VERSION}"

log_step "Deploying auffi ${APP_VERSION} → ${DEPLOY_SSH}:${DEPLOY_PATH}"

# ---------------------------------------------------------------------------
# Step 1: Pre-flight checks
# ---------------------------------------------------------------------------
log_step "Pre-flight checks"

maybe_run "Verify SSH reachable" ssh_check || {
  log_error "Cannot reach ${DEPLOY_SSH} via SSH"
  exit 1
}

maybe_run "Verify Docker available on remote" \
  remote "docker info >/dev/null 2>&1" || {
  log_error "Docker is not available on the remote host"
  exit 1
}

# ---------------------------------------------------------------------------
# Step 2: Build backend image locally
# ---------------------------------------------------------------------------
log_step "Build backend image (auffi-backend:${APP_VERSION})"

maybe_run "docker build backend" \
  docker build \
    --tag "auffi-backend:${APP_VERSION}" \
    "${REPO_ROOT}/backend"

# Keep the last 3 local build tags; prune older ones quietly
# (failure here is non-fatal — just a cleanup step)
maybe_run "Tag image as :latest locally" \
  docker tag "auffi-backend:${APP_VERSION}" "auffi-backend:latest" || true

# ---------------------------------------------------------------------------
# Step 3: Build viewer
# ---------------------------------------------------------------------------
log_step "Build viewer (npm ci && npm run build)"

maybe_run "viewer npm ci" \
  bash -c "cd '${REPO_ROOT}/viewer' && npm ci"

maybe_run "viewer npm run build" \
  bash -c "cd '${REPO_ROOT}/viewer' && npm run build"

# ---------------------------------------------------------------------------
# Step 3b: Build dashboard (gh #38 — unattended-access SPA)
# ---------------------------------------------------------------------------
log_step "Build dashboard (npm ci && npm run build)"

maybe_run "dashboard npm ci" \
  bash -c "cd '${REPO_ROOT}/dashboard' && npm ci"

maybe_run "dashboard npm run build" \
  bash -c "cd '${REPO_ROOT}/dashboard' && npm run build"

# ---------------------------------------------------------------------------
# Step 4: Ensure remote deploy path exists
# ---------------------------------------------------------------------------
log_step "Ensure remote deploy path: ${DEPLOY_PATH}"

maybe_run "Create ${DEPLOY_PATH} on remote" \
  remote "mkdir -p '${DEPLOY_PATH}'"

# ---------------------------------------------------------------------------
# Step 5: Transfer backend image
# ---------------------------------------------------------------------------
log_step "Transfer backend image to remote"

IMAGE_TAR="/tmp/auffi-backend-${APP_VERSION}.tar.gz"

maybe_run "Save image to tarball" \
  bash -c "docker save 'auffi-backend:${APP_VERSION}' | gzip > '${IMAGE_TAR}'"

maybe_run "rsync image tarball to remote" \
  rsync_to "${IMAGE_TAR}" "${DEPLOY_PATH}/"

maybe_run "Load image on remote" \
  remote "gunzip -c '${DEPLOY_PATH}/auffi-backend-${APP_VERSION}.tar.gz' | docker load"

# Read APP_VERSION from .env.prod on the remote and retag the freshly-loaded
# image to match — so docker compose can resolve ${APP_VERSION:-latest}.
maybe_run "Tag loaded image to match remote APP_VERSION (and :latest)" \
  remote "ENV_APP_VERSION=\$(grep -E '^APP_VERSION=' '${DEPLOY_PATH}/.env.prod' 2>/dev/null | cut -d= -f2- | tr -d '\"'); \
    docker tag 'auffi-backend:${APP_VERSION}' 'auffi-backend:latest'; \
    if [ -n \"\${ENV_APP_VERSION}\" ] && [ \"\${ENV_APP_VERSION}\" != '${APP_VERSION}' ]; then \
      docker tag 'auffi-backend:${APP_VERSION}' \"auffi-backend:\${ENV_APP_VERSION}\"; \
      echo \"[deploy] also tagged as auffi-backend:\${ENV_APP_VERSION}\"; \
    fi"

# Keep last 3 image tarballs on remote
maybe_run "Prune old image tarballs (keep 3)" \
  remote "ls -t '${DEPLOY_PATH}'/auffi-backend-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm --" || true

# Clean up local tarball
[[ "${DRY_RUN}" == "false" ]] && rm -f "${IMAGE_TAR}" || true

# ---------------------------------------------------------------------------
# Step 6: rsync config and viewer dist
# ---------------------------------------------------------------------------
log_step "rsync compose, config, and viewer dist to remote"

maybe_run "rsync docker-compose.prod.yml" \
  rsync_to \
    "${REPO_ROOT}/docker-compose.prod.yml" \
    "${DEPLOY_PATH}/"

if [[ -n "${CLUSTER_PROXY:-}" ]]; then
  maybe_run "rsync docker-compose.cluster.yml" \
    rsync_to \
      "${REPO_ROOT}/docker-compose.cluster.yml" \
      "${DEPLOY_PATH}/"
  maybe_run "rsync nginx/ (viewer static server config)" \
    rsync_to \
      "${REPO_ROOT}/nginx/" \
      "${DEPLOY_PATH}/nginx/" \
      --delete
  # In cluster mode the shared /opt/caddyserver Caddy owns reverse-proxy duties,
  # so we don't ship our own caddy/ to /opt/screenie/caddy.
else
  maybe_run "rsync caddy/" \
    rsync_to \
      "${REPO_ROOT}/caddy/" \
      "${DEPLOY_PATH}/caddy/" \
      --delete
fi

maybe_run "rsync coturn/" \
  rsync_to \
    "${REPO_ROOT}/coturn/" \
    "${DEPLOY_PATH}/coturn/" \
    --delete

maybe_run "rsync .env.prod.example" \
  rsync_to \
    "${REPO_ROOT}/.env.prod.example" \
    "${DEPLOY_PATH}/"

maybe_run "rsync viewer/dist → viewer-dist/" \
  rsync_to \
    "${REPO_ROOT}/viewer/dist/" \
    "${DEPLOY_PATH}/viewer-dist/" \
    --delete \
    --exclude=/download/

# gh #38: the dashboard service in docker-compose.prod.yml bind-mounts
# ./dashboard-dist into the auffi-dashboard nginx sidecar. Ship the
# built SPA there.
maybe_run "rsync dashboard/dist → dashboard-dist/" \
  rsync_to \
    "${REPO_ROOT}/dashboard/dist/" \
    "${DEPLOY_PATH}/dashboard-dist/" \
    --delete

# ---------------------------------------------------------------------------
# Step 7: Populate the viewer-static Docker volume from the synced dist
# ---------------------------------------------------------------------------
log_step "Populate viewer-static volume"

if [[ -z "${CLUSTER_PROXY:-}" ]]; then
  maybe_run "Copy viewer-dist into viewer-static volume" \
    remote "docker run --rm \
      -v screenie_viewer-static:/data \
      -v '${DEPLOY_PATH}/viewer-dist':/src:ro \
      busybox sh -c 'cp -a /src/. /data/'"
else
  log_info "Cluster mode — viewer container bind-mounts viewer-dist directly; skipping volume copy"
fi

# ---------------------------------------------------------------------------
# Step 8: Ensure .env.prod exists on remote (never overwrite if present)
# ---------------------------------------------------------------------------
log_step "Ensure .env.prod on remote"

maybe_run "Place .env.prod.example if .env.prod absent" \
  remote "test -f '${DEPLOY_PATH}/.env.prod' || { echo '[deploy] .env.prod missing — placing .env.prod.example as .env.prod; EDIT before restarting'; cp '${DEPLOY_PATH}/.env.prod.example' '${DEPLOY_PATH}/.env.prod'; }"

# ---------------------------------------------------------------------------
# Step 9: Start / update services
# ---------------------------------------------------------------------------
log_step "docker compose up -d"

maybe_run "docker compose up -d" \
  remote_compose "up -d --remove-orphans"

# ---------------------------------------------------------------------------
# Step 10: Wait for health
# ---------------------------------------------------------------------------
log_step "Waiting for backend health check"

if [[ "${DRY_RUN}" == "false" ]]; then
  wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 90
fi

# ---------------------------------------------------------------------------
# Step 11: Report
# ---------------------------------------------------------------------------
log_step "Deployment status"

if [[ "${DRY_RUN}" == "false" ]]; then
  remote_compose "ps"
  log_ok "Deployment of auffi ${APP_VERSION} complete."
else
  log_dry "-- deploy complete (dry run, no remote commands were executed) --"
fi
