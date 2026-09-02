#!/usr/bin/env bash
# ops/update.sh — incremental update of backend + viewer only.
#
# ============================================================================
# HINWEIS: ops/deploy.sh ist der KANONISCHE Deploy-Pfad — auch für Routine-
# Updates (es überspringt unveränderte Builds selbst). Dieses Skript ist der
# schlanke Notnagel für backend+viewer-only-Hotfixes und lässt bewusst aus:
#   * Deploy-Lock (parallel zu deploy.sh möglich)
#   * Deploy-Log-Append (deploy.sh-Diff-Preview, Image-Prune-KEEP_LIST und
#     --rollback kennen hiermit deployte Versionen NICHT)
#   * Dashboard-Build, Config-Sync, erweiterte Health-Checks
# --rollback wählt Tarballs nach mtime, nicht nach Deploy-Log.
# ============================================================================
#
# Usage:
#   ./ops/update.sh [--dry-run] [--version <tag>] [--rollback]
#   ./ops/update.sh --help
#
# Restarts only the backend container; caddy and coturn remain untouched
# unless their configs have changed (which this script does not sync —
# use ops/deploy.sh for full config updates).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=ops/lib.sh
source "${SCRIPT_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
VERSION=""
ROLLBACK=false

print_help() {
  cat <<EOF
Usage: $(basename "$0") [options]

Incremental update — builds backend + viewer, transfers them to the VPS,
restarts only the backend service, and verifies health. Rolls back on failure.

Options:
  --dry-run          Print what would happen without executing remote commands.
  --version <tag>    Explicit image tag (default: git short SHA).
  --rollback         Roll back to the previous deployed image tag.
  --help             Show this help and exit.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true ;;
    --version)  VERSION="$2"; shift ;;
    --rollback) ROLLBACK=true ;;
    --help)     print_help; exit 0 ;;
    *)          log_error "Unknown option: $1"; print_help; exit 1 ;;
  esac
  shift
done

load_deploy_env

# ---------------------------------------------------------------------------
# Rollback path
# ---------------------------------------------------------------------------
if [[ "${ROLLBACK}" == "true" ]]; then
  log_step "Rolling back to previous version"

  PREV_TAG="$(remote "ls -t '${DEPLOY_PATH}'/auffi-backend-*.tar.gz 2>/dev/null \
    | sed 's|.*auffi-backend-||;s|\.tar\.gz||' | sed -n '2p'")"

  if [[ -z "${PREV_TAG}" ]]; then
    log_error "No previous image tarball found on remote — cannot roll back"
    exit 1
  fi

  log_info "Rolling back to auffi-backend:${PREV_TAG}"

  maybe_run "Load previous image on remote" \
    remote "gunzip -c '${DEPLOY_PATH}/auffi-backend-${PREV_TAG}.tar.gz' | docker load"

  maybe_run "Update APP_VERSION in .env.prod" \
    remote "sed -i 's|^APP_VERSION=.*|APP_VERSION=${PREV_TAG}|' '${DEPLOY_PATH}/.env.prod'"

  maybe_run "Restart backend" \
    remote_compose "up -d --no-deps backend"

  if [[ "${DRY_RUN}" == "false" ]]; then
    wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 60
    log_ok "Rollback to ${PREV_TAG} successful"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Forward update path
# ---------------------------------------------------------------------------
if [[ -z "${VERSION}" ]]; then
  VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "latest")"
fi
export APP_VERSION="${VERSION}"

log_step "Incremental update auffi ${APP_VERSION} → ${DEPLOY_SSH}:${DEPLOY_PATH}"

# Pre-flight
maybe_run "Verify SSH reachable" ssh_check || {
  log_error "Cannot reach ${DEPLOY_SSH} via SSH"
  exit 1
}

# Build backend
log_step "Build backend image (auffi-backend:${APP_VERSION})"
maybe_run "docker build backend" \
  docker build \
    --tag "auffi-backend:${APP_VERSION}" \
    "${REPO_ROOT}/backend"

# Build viewer
log_step "Build viewer"
maybe_run "viewer npm ci" \
  bash -c "cd '${REPO_ROOT}/viewer' && npm ci"
maybe_run "viewer npm run build" \
  bash -c "cd '${REPO_ROOT}/viewer' && npm run build"

# Transfer backend image
IMAGE_TAR="/tmp/auffi-backend-${APP_VERSION}.tar.gz"
maybe_run "Save image tarball" \
  bash -c "docker save 'auffi-backend:${APP_VERSION}' | gzip > '${IMAGE_TAR}'"
maybe_run "rsync image tarball" \
  rsync_to "${IMAGE_TAR}" "${DEPLOY_PATH}/"
maybe_run "Load image on remote" \
  remote "gunzip -c '${DEPLOY_PATH}/auffi-backend-${APP_VERSION}.tar.gz' | docker load"
maybe_run "Prune old image tarballs (keep 3)" \
  remote "ls -t '${DEPLOY_PATH}'/auffi-backend-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm --" || true
[[ "${DRY_RUN}" == "false" ]] && rm -f "${IMAGE_TAR}" || true

# Transfer viewer dist — same helper as deploy.sh Step 10, so the legacy
# /download/ flat files survive this --delete too (they did not until 0.7.1).
maybe_run "rsync viewer/dist → viewer-dist/" \
  rsync_viewer_dist "${REPO_ROOT}/viewer/dist/" "${DEPLOY_PATH}/viewer-dist/"

# Volume-Copy nur standalone — im Cluster-Modus bind-mountet der
# auffi-viewer-Container ${DEPLOY_PATH}/viewer-dist direkt (siehe
# docker-compose.cluster.yml), der rsync oben reicht dort.
if [[ -z "${CLUSTER_PROXY:-}" ]]; then
  maybe_run "Copy viewer-dist into viewer-static volume" \
    populate_viewer_static_volume
else
  log_info "Cluster mode — viewer container bind-mounts viewer-dist directly"
fi

# Update APP_VERSION in .env.prod so compose picks it up on restart
maybe_run "Update APP_VERSION in .env.prod" \
  remote "sed -i 's|^APP_VERSION=.*|APP_VERSION=${APP_VERSION}|' '${DEPLOY_PATH}/.env.prod'"

# Restart only backend
log_step "Restart backend service"
maybe_run "docker compose up -d --no-deps backend" \
  remote_compose "up -d --no-deps backend"

# Health check + rollback on failure
if [[ "${DRY_RUN}" == "false" ]]; then
  if ! wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 60; then
    log_warn "Health check failed — initiating automatic rollback"
    "${SCRIPT_DIR}/update.sh" --rollback
    exit 1
  fi

  log_step "Service status"
  remote_compose "ps"
  log_ok "Update to auffi ${APP_VERSION} complete."
fi
