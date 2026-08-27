#!/usr/bin/env bash
# ops/deploy.sh — full idempotent deployment to the VPS.
#
# Usage:
#   ./ops/deploy.sh [--dry-run] [--version <tag>] [--yes] [--skip-tests]
#                   [--skip-image-prune] [--notes "<text>"]
#   ./ops/deploy.sh --rollback [--yes]
#   ./ops/deploy.sh --help
#
# Default-Flow:
#   1) Pre-flight (lock, ssh, docker, nginx -t, caddy validate)
#   2) Tests (viewer + backend + dashboard) — skip mit --skip-tests
#   3) Diff-Preview (git log seit dem zuletzt deployten SHA) + Confirm
#   4) Build backend image — skip wenn :${APP_VERSION} schon remote
#   5) Build viewer + dashboard (npm ci wird übersprungen wenn package-lock unverändert)
#   6) Transfer image-tarball (mit Trap-Cleanup)
#   7) Hash-Diff der Configs gegen prod → Liste der zu restartenden Services
#   8) rsync Compose, Configs, viewer-dist, dashboard-dist, ops-Skripte
#      (backup.sh, health-check.sh, lib.sh)
#   9) docker compose up -d (recreatet bei Image- oder Compose-Spec-Änderung)
#  10) Service-Restart für geänderte Configs (Single-File-Bind-Mount-Stale-Fix)
#  11) Erweiterte Health-Checks (homepage, healthz, llms.txt, robots.txt, 404)
#  12) Image-Prune auf prod (keep last 3 + :latest)
#  13) Deploy-Log-Append auf prod
#
# Rollback:
#   --rollback liest den vorletzten SHA aus /opt/screenie/.deploy-log,
#   setzt APP_VERSION in .env.prod, und macht compose up -d.
#   Setzt voraus, dass das alte Image noch auf prod ist (Image-Prune
#   hält die letzten 3 + :latest vor).
#
# Environment:
#   Reads ops/.env.deploy (or env vars) for SSH target and paths.
#   APP_VERSION — override image tag (default: git short SHA)
#   CLUSTER_PROXY — set non-empty to use docker-compose.cluster.yml overlay

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
SKIP_TESTS=false
SKIP_IMAGE_PRUNE=false
ROLLBACK=false
NOTES=""

print_help() {
  cat <<EOF
Usage: $(basename "$0") [options]

Full idempotent deployment — builds images locally, transfers them to the VPS,
syncs config + viewer dist, restarts services that need it (config or image
change), waits for health, prunes old images, appends to deploy-log.

Options:
  --dry-run             Print what would happen without executing remote commands.
  --version <tag>       Image tag to build and deploy (default: git short SHA).
  --yes                 Skip interactive confirmation prompts.
  --skip-tests          Skip the pre-deploy npm/cargo test runs.
  --skip-image-prune    Don't prune old backend images on prod after deploy.
  --notes "<text>"      Note appended to the deploy-log entry.
  --rollback            Roll back to the previous SHA from /opt/screenie/.deploy-log.
  --help                Show this help and exit.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=true ;;
    --yes)                YES=true ;;
    --version)            VERSION="$2"; shift ;;
    --skip-tests)         SKIP_TESTS=true ;;
    --skip-image-prune)   SKIP_IMAGE_PRUNE=true ;;
    --notes)              NOTES="$2"; shift ;;
    --rollback)           ROLLBACK=true ;;
    --help)               print_help; exit 0 ;;
    *)                    log_error "Unknown option: $1"; print_help; exit 1 ;;
  esac
  shift
done

load_deploy_env
# DEPLOY_LOG_REMOTE wird in lib.sh aus DEPLOY_PATH abgeleitet — neu setzen
# nachdem load_deploy_env gelaufen ist, falls eine ältere Definition aus
# einer leeren DEPLOY_PATH hochgezogen wurde.
DEPLOY_LOG_REMOTE="${DEPLOY_PATH}/.deploy-log"

# ---------------------------------------------------------------------------
# Lock + Cleanup-Trap (vor jeglicher destruktiven Aktion).
# ---------------------------------------------------------------------------
acquire_deploy_lock
install_cleanup_trap

# ---------------------------------------------------------------------------
# Rollback-Modus — eigener kurzer Flow, dann exit.
# ---------------------------------------------------------------------------
if [[ "${ROLLBACK}" == "true" ]]; then
  log_step "Rollback-Modus"

  maybe_run "Verify SSH reachable" ssh_check || {
    log_error "Cannot reach ${DEPLOY_SSH}"
    exit 1
  }

  # Häufigster Rollback-Fall: der letzte Deploy ist an den Health-Checks
  # gescheitert und hat NIE einen Log-Eintrag bekommen (Step 16 läuft nach
  # Step 15) — .env.prod trägt aber schon den kaputten SHA. Dann ist der
  # LETZTE Log-Eintrag der letzte gute Stand, nicht der vorletzte.
  LAST_LOGGED_SHA="$(deploy_log_last_sha)"
  RUNNING_SHA="$(remote_env_app_version)"
  if [[ -n "${LAST_LOGGED_SHA}" && -n "${RUNNING_SHA}" && "${LAST_LOGGED_SHA}" != "${RUNNING_SHA}" ]]; then
    PREV_SHA="${LAST_LOGGED_SHA}"
    log_info "Laufender SHA ${RUNNING_SHA} ist nicht im Deploy-Log (gescheiterter Deploy) — Rollback auf letzten geloggten SHA."
  else
    PREV_SHA="$(deploy_log_previous_sha)"
  fi
  if [[ -z "${PREV_SHA}" ]]; then
    log_error "Kein vorheriger SHA im Deploy-Log gefunden (${DEPLOY_LOG_REMOTE}). Mindestens 2 Einträge nötig."
    exit 1
  fi

  log_info "Roll back: vorheriger SHA war ${PREV_SHA}"
  if ! remote_image_exists "auffi-backend:${PREV_SHA}"; then
    log_error "Image auffi-backend:${PREV_SHA} ist nicht mehr auf prod (vom Prune erwischt?). Rollback nicht möglich ohne re-build mit --version ${PREV_SHA}."
    exit 1
  fi

  if [[ "${YES}" != "true" ]]; then
    confirm "Wirklich auf ${PREV_SHA} zurückrollen?"
  fi

  maybe_run "Update APP_VERSION in .env.prod" \
    remote "sed -i 's|^APP_VERSION=.*|APP_VERSION=${PREV_SHA}|' '${DEPLOY_PATH}/.env.prod'"

  maybe_run "Retag image to :latest" \
    remote "docker tag 'auffi-backend:${PREV_SHA}' 'auffi-backend:latest'"

  maybe_run "docker compose up -d (rollback recreate)" \
    remote_compose "up -d --remove-orphans"

  if [[ "${DRY_RUN}" == "false" ]]; then
    wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 90
  fi

  maybe_run "Append rollback to deploy-log" \
    deploy_log_append "${PREV_SHA}" "ROLLBACK${NOTES:+ — ${NOTES}}"

  log_ok "Rollback auf ${PREV_SHA} fertig."
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve image version (regular deploy path).
# ---------------------------------------------------------------------------
if [[ -z "${VERSION}" ]]; then
  VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "latest")"
fi
export APP_VERSION="${VERSION}"

log_step "Deploying auffi ${APP_VERSION} → ${DEPLOY_SSH}:${DEPLOY_PATH}"

# ---------------------------------------------------------------------------
# Step 1: Pre-flight checks
# ---------------------------------------------------------------------------
log_step "Pre-flight: SSH + Docker"

maybe_run "Verify SSH reachable" ssh_check || {
  log_error "Cannot reach ${DEPLOY_SSH} via SSH"
  exit 1
}

maybe_run "Verify Docker on remote" \
  remote "docker info >/dev/null 2>&1" || {
  log_error "Docker not available on remote"
  exit 1
}

maybe_run "Verify Docker local" \
  docker info >/dev/null 2>&1 || {
  log_error "Local Docker not running"
  exit 1
}

# ---------------------------------------------------------------------------
# Step 2: Pre-flight config validation (catches typos before they reach prod)
# ---------------------------------------------------------------------------
log_step "Pre-flight: nginx -t / caddy validate"

if [[ "${DRY_RUN}" == "false" ]]; then
  nginx_validate_local "${REPO_ROOT}/nginx/auffi-viewer.conf"
  nginx_validate_local "${REPO_ROOT}/nginx/auffi-dashboard.conf"
  if [[ -z "${CLUSTER_PROXY:-}" ]]; then
    caddy_validate_local "${REPO_ROOT}/caddy/Caddyfile"
  else
    log_info "Cluster mode — skipping caddy validation (cluster-Caddy wird out-of-band verwaltet)"
  fi
else
  log_dry "skip config validation in dry-run"
fi

# ---------------------------------------------------------------------------
# Step 3: Pre-deploy tests
# ---------------------------------------------------------------------------
if [[ "${SKIP_TESTS}" == "true" ]]; then
  log_step "Tests übersprungen (--skip-tests)"
elif [[ "${DRY_RUN}" == "true" ]]; then
  log_step "Tests übersprungen (dry-run)"
else
  log_step "Pre-deploy tests"

  log_info "viewer: npm test"
  ( cd "${REPO_ROOT}/viewer" && npm test --silent ) || {
    log_error "viewer-Tests rot — Deploy abgebrochen. Nutze --skip-tests um zu erzwingen."
    exit 1
  }

  log_info "backend: npm test"
  ( cd "${REPO_ROOT}/backend" && npm test --silent ) || {
    log_error "backend-Tests rot — Deploy abgebrochen."
    exit 1
  }

  # dashboard-dist wird in Step 6+10 genauso gebaut und deployed wie der
  # viewer — also auch genauso gaten.
  log_info "dashboard: npm test"
  ( cd "${REPO_ROOT}/dashboard" && npm test --silent ) || {
    log_error "dashboard-Tests rot — Deploy abgebrochen."
    exit 1
  }

  # Sharer wird NICHT auf den Server deployed (Desktop-App, separater
  # Release-Flow). Cargo-Tests sind langsam (~5min cold) und nicht
  # Deploy-Critical. Manuell laufen lassen vor dem Sharer-Release:
  #   cd sharer/src-tauri && cargo test --lib

  log_ok "Backend + viewer + dashboard Tests grün"
fi

# ---------------------------------------------------------------------------
# Step 4: Diff-Preview seit dem zuletzt deployten SHA
# ---------------------------------------------------------------------------
log_step "Diff seit dem zuletzt deployten SHA"

LAST_DEPLOYED_SHA="$(deploy_log_last_sha)"
if [[ -z "${LAST_DEPLOYED_SHA}" ]]; then
  log_info "Kein Deploy-Log vorhanden — erster Deploy mit diesem Skript-Stand."
elif [[ "${LAST_DEPLOYED_SHA}" == "${APP_VERSION}" ]]; then
  log_warn "Last-deployed-SHA == current-SHA (${APP_VERSION}) — keine Code-Änderungen seit dem letzten Deploy."
else
  log_info "Last deployed: ${LAST_DEPLOYED_SHA}, current: ${APP_VERSION}"
  if git -C "${REPO_ROOT}" rev-parse "${LAST_DEPLOYED_SHA}" >/dev/null 2>&1; then
    echo
    git -C "${REPO_ROOT}" log --oneline --no-decorate "${LAST_DEPLOYED_SHA}..HEAD" | head -30
    echo
    git -C "${REPO_ROOT}" diff --stat "${LAST_DEPLOYED_SHA}..HEAD" | tail -40
    echo
  else
    log_warn "SHA ${LAST_DEPLOYED_SHA} ist nicht lokal — kein Diff möglich."
  fi
fi

if [[ "${YES}" != "true" && "${DRY_RUN}" == "false" ]]; then
  confirm "Mit Deploy von ${APP_VERSION} fortfahren?"
fi

# ---------------------------------------------------------------------------
# Step 5: Build backend image (skip wenn schon remote)
# ---------------------------------------------------------------------------
SKIP_IMAGE_TRANSFER=false
if [[ "${DRY_RUN}" == "false" ]] && remote_image_exists "auffi-backend:${APP_VERSION}"; then
  log_step "Build backend: skipped — auffi-backend:${APP_VERSION} ist schon auf prod"
  SKIP_IMAGE_TRANSFER=true
else
  log_step "Build backend image (auffi-backend:${APP_VERSION})"

  maybe_run "docker build backend" \
    docker build \
      --tag "auffi-backend:${APP_VERSION}" \
      "${REPO_ROOT}/backend"

  maybe_run "Tag image as :latest locally" \
    docker tag "auffi-backend:${APP_VERSION}" "auffi-backend:latest" || true
fi

# ---------------------------------------------------------------------------
# Step 6: Build viewer + dashboard (npm ci nur wenn package-lock geändert)
# ---------------------------------------------------------------------------
log_step "Build viewer + dashboard"

build_frontend() {
  local pkg_dir="$1"
  local cache="${pkg_dir}/node_modules/.deploy-cache-hash"
  local cur
  cur=$(sha256sum "${pkg_dir}/package-lock.json" | awk '{print $1}')

  if [[ -d "${pkg_dir}/node_modules" && -f "${cache}" && "$(cat "${cache}")" == "${cur}" ]]; then
    log_info "$(basename "${pkg_dir}"): node_modules aktuell — skip npm ci"
  else
    log_info "$(basename "${pkg_dir}"): npm ci"
    ( cd "${pkg_dir}" && npm ci --silent )
    echo "${cur}" > "${cache}"
  fi

  log_info "$(basename "${pkg_dir}"): npm run build"
  ( cd "${pkg_dir}" && npm run build --silent )
}

if [[ "${DRY_RUN}" == "false" ]]; then
  build_frontend "${REPO_ROOT}/viewer"
  build_frontend "${REPO_ROOT}/dashboard"
else
  log_dry "build_frontend viewer + dashboard (skipped in dry-run)"
fi

# ---------------------------------------------------------------------------
# Step 7: Ensure remote deploy path exists
# ---------------------------------------------------------------------------
log_step "Ensure remote deploy path: ${DEPLOY_PATH}"

maybe_run "Create ${DEPLOY_PATH} on remote" \
  remote "mkdir -p '${DEPLOY_PATH}' '${DEPLOY_PATH}/ops'"

# ---------------------------------------------------------------------------
# Step 8: Transfer backend image (skipped if image already on prod)
# ---------------------------------------------------------------------------
if [[ "${SKIP_IMAGE_TRANSFER}" == "true" ]]; then
  log_step "Transfer image: skipped"
else
  log_step "Transfer backend image to remote"

  IMAGE_TAR="/tmp/auffi-backend-${APP_VERSION}.tar.gz"
  register_cleanup_file "${IMAGE_TAR}"

  maybe_run "Save image to tarball" \
    bash -c "docker save 'auffi-backend:${APP_VERSION}' | gzip > '${IMAGE_TAR}'"

  maybe_run "rsync image tarball" \
    rsync_to "${IMAGE_TAR}" "${DEPLOY_PATH}/"

  maybe_run "Load image on remote" \
    remote "gunzip -c '${DEPLOY_PATH}/auffi-backend-${APP_VERSION}.tar.gz' | docker load"

  maybe_run "Retag image (sync mit .env.prod APP_VERSION + :latest)" \
    remote "ENV_APP_VERSION=\$(grep -E '^APP_VERSION=' '${DEPLOY_PATH}/.env.prod' 2>/dev/null | cut -d= -f2- | tr -d '\"'); \
      docker tag 'auffi-backend:${APP_VERSION}' 'auffi-backend:latest'; \
      if [ -n \"\${ENV_APP_VERSION}\" ] && [ \"\${ENV_APP_VERSION}\" != '${APP_VERSION}' ]; then \
        docker tag 'auffi-backend:${APP_VERSION}' \"auffi-backend:\${ENV_APP_VERSION}\"; \
      fi"

  maybe_run "Prune old image tarballs on remote (keep 3)" \
    remote "ls -t '${DEPLOY_PATH}'/auffi-backend-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm --" || true
fi

# ---------------------------------------------------------------------------
# Step 9: Config-Diff — welche Service-Configs haben sich geändert?
# Sammelt eine Liste von Service-Container-Namen, die nach dem rsync
# manuell restartet werden müssen (Single-File-Bind-Mount-Stale-Fix).
# ---------------------------------------------------------------------------
log_step "Config-Diff (welche Service-Configs haben sich geändert?)"

SERVICES_TO_RESTART=()
if [[ "${DRY_RUN}" == "false" ]]; then
  # auffi-viewer existiert nur im Cluster-Overlay (standalone served Caddy
  # den Viewer aus dem viewer-static-Volume) — ein `docker restart` auf
  # den nicht existenten Container würde den Deploy unter set -e abbrechen.
  if [[ -n "${CLUSTER_PROXY:-}" ]] && file_changed_on_remote \
      "${REPO_ROOT}/nginx/auffi-viewer.conf" \
      "${DEPLOY_PATH}/nginx/auffi-viewer.conf"; then
    SERVICES_TO_RESTART+=("auffi-viewer")
    log_info "nginx/auffi-viewer.conf changed → auffi-viewer wird restartet"
  fi
  if file_changed_on_remote \
      "${REPO_ROOT}/nginx/auffi-dashboard.conf" \
      "${DEPLOY_PATH}/nginx/auffi-dashboard.conf"; then
    SERVICES_TO_RESTART+=("auffi-dashboard")
    log_info "nginx/auffi-dashboard.conf changed → auffi-dashboard wird restartet"
  fi
  # coturn nutzt eine .tmpl die beim Container-Start gerendert wird —
  # also reicht ein restart. (In Cluster + Standalone identisch.)
  if file_changed_on_remote \
      "${REPO_ROOT}/coturn/turnserver.conf.tmpl" \
      "${DEPLOY_PATH}/coturn/turnserver.conf.tmpl"; then
    SERVICES_TO_RESTART+=("auffi-coturn")
    log_info "coturn-Config changed → auffi-coturn wird restartet"
  fi
  if [[ -z "${CLUSTER_PROXY:-}" ]] && file_changed_on_remote \
      "${REPO_ROOT}/caddy/Caddyfile" \
      "${DEPLOY_PATH}/caddy/Caddyfile"; then
    SERVICES_TO_RESTART+=("auffi-caddy")
    log_info "caddy/Caddyfile changed → auffi-caddy wird restartet"
  fi
  if [[ ${#SERVICES_TO_RESTART[@]} -eq 0 ]]; then
    log_info "Keine Config-Änderungen — kein expliziter Service-Restart nötig."
  fi
else
  log_dry "skip config-diff in dry-run"
fi

# ---------------------------------------------------------------------------
# Step 10: rsync compose, config, viewer-dist, dashboard-dist, ops-Skripte
# ---------------------------------------------------------------------------
log_step "rsync compose + config + dist + ops-Skripte"

maybe_run "rsync docker-compose.prod.yml" \
  rsync_to "${REPO_ROOT}/docker-compose.prod.yml" "${DEPLOY_PATH}/"

if [[ -n "${CLUSTER_PROXY:-}" ]]; then
  maybe_run "rsync docker-compose.cluster.yml" \
    rsync_to "${REPO_ROOT}/docker-compose.cluster.yml" "${DEPLOY_PATH}/"
else
  maybe_run "rsync caddy/" \
    rsync_to "${REPO_ROOT}/caddy/" "${DEPLOY_PATH}/caddy/" --delete
fi

# nginx/ wird in BEIDEN Modi gebraucht: docker-compose.prod.yml bind-mountet
# ./nginx/auffi-dashboard.conf in den Dashboard-Sidecar. Fehlt die Datei,
# legt Docker ein Verzeichnis am Mount-Pfad an und nginx startet ohne
# Server-Config (/dashboard/* tot).
maybe_run "rsync nginx/" \
  rsync_to "${REPO_ROOT}/nginx/" "${DEPLOY_PATH}/nginx/" --delete

maybe_run "rsync coturn/" \
  rsync_to "${REPO_ROOT}/coturn/" "${DEPLOY_PATH}/coturn/" --delete

maybe_run "rsync .env.prod.example" \
  rsync_to "${REPO_ROOT}/.env.prod.example" "${DEPLOY_PATH}/"

maybe_run "rsync ops/backup.sh" \
  rsync_to "${REPO_ROOT}/ops/backup.sh" "${DEPLOY_PATH}/ops/backup.sh"

# health-check.sh läuft als Cron auf dem VPS (ops/README § 9) und sourced
# lib.sh — beide müssen mitgeshippt werden, sonst schlägt der dokumentierte
# Crontab-Eintrag mit "No such file" fehl.
maybe_run "rsync ops/health-check.sh" \
  rsync_to "${REPO_ROOT}/ops/health-check.sh" "${DEPLOY_PATH}/ops/health-check.sh"
maybe_run "rsync ops/lib.sh" \
  rsync_to "${REPO_ROOT}/ops/lib.sh" "${DEPLOY_PATH}/ops/lib.sh"

# Excludes: manuell auf dem Server platzierte Sharer-Binaries in /download/
# (Flat-Hosting-Altbestand, siehe nginx/auffi-viewer.conf) überleben das
# --delete. Kein *.dmg — es gibt keinen macOS-Build (CLAUDE.md).
maybe_run "rsync viewer/dist → viewer-dist/" \
  rsync_to "${REPO_ROOT}/viewer/dist/" "${DEPLOY_PATH}/viewer-dist/" \
    --delete \
    --exclude=/download/*.deb \
    --exclude=/download/*.rpm \
    --exclude=/download/*.AppImage \
    --exclude=/download/*.msi \
    --exclude=/download/*.exe \
    --exclude=/download/*.sh \
    --exclude=/download/latest.txt

maybe_run "rsync dashboard/dist → dashboard-dist/" \
  rsync_to "${REPO_ROOT}/dashboard/dist/" "${DEPLOY_PATH}/dashboard-dist/" --delete

# ---------------------------------------------------------------------------
# Step 11: Populate viewer-static volume (standalone only)
# ---------------------------------------------------------------------------
log_step "Populate viewer-static volume (skipped im Cluster-Modus)"

if [[ -z "${CLUSTER_PROXY:-}" ]]; then
  maybe_run "Copy viewer-dist into viewer-static volume" \
    remote "docker run --rm \
      -v screenie_viewer-static:/data \
      -v '${DEPLOY_PATH}/viewer-dist':/src:ro \
      busybox sh -c 'cp -a /src/. /data/'"
else
  log_info "Cluster mode — viewer container bind-mounts viewer-dist directly"
fi

# ---------------------------------------------------------------------------
# Step 12: Ensure .env.prod exists on remote (never overwrite if present)
# ---------------------------------------------------------------------------
log_step "Ensure .env.prod on remote"

maybe_run "Place .env.prod.example if .env.prod absent" \
  remote "test -f '${DEPLOY_PATH}/.env.prod' || { echo '[deploy] .env.prod missing — placing .env.prod.example as .env.prod; EDIT before restarting'; cp '${DEPLOY_PATH}/.env.prod.example' '${DEPLOY_PATH}/.env.prod'; }"

# Pin APP_VERSION in .env.prod to the SHA we just deployed, so compose runs
# the freshly-loaded auffi-backend:${APP_VERSION} image AND /healthz reports
# the right version. Without this, .env.prod keeps a stale hand-set APP_VERSION
# (the backend mis-labels its version even though the new code is running).
maybe_run "Sync APP_VERSION in .env.prod → ${APP_VERSION}" \
  remote "sed -i 's|^APP_VERSION=.*|APP_VERSION=${APP_VERSION}|' '${DEPLOY_PATH}/.env.prod'"

# ---------------------------------------------------------------------------
# Step 13: docker compose up -d (recreatet bei Image-/Compose-Spec-Änderung)
# ---------------------------------------------------------------------------
log_step "docker compose up -d"

maybe_run "docker compose up -d" \
  remote_compose "up -d --remove-orphans"

# ---------------------------------------------------------------------------
# Step 14: Service-Restart für die in Step 9 markierten Configs.
# Compose hat den Container nicht recreated (Spec war unverändert), aber
# der Single-File-Bind-Mount hängt am alten Inode — wir müssen den
# Container manuell restarten damit die neue Config geladen wird.
# ---------------------------------------------------------------------------
if [[ ${#SERVICES_TO_RESTART[@]} -gt 0 ]]; then
  log_step "Service-Restart für geänderte Configs"
  for svc in "${SERVICES_TO_RESTART[@]}"; do
    maybe_run "docker restart ${svc}" \
      remote "docker restart '${svc}' >/dev/null"
  done
else
  log_info "Step 14 übersprungen (nichts zu restarten)"
fi

# ---------------------------------------------------------------------------
# Step 15: Erweiterte Health-Checks
# ---------------------------------------------------------------------------
log_step "Health-Checks (homepage, healthz, llms.txt, robots.txt, 404)"

if [[ "${DRY_RUN}" == "false" ]]; then
  wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 90
  # Smoke-Tests — Hard-fail bei Regression. wait_healthy decken den
  # Backend-Start ab, hier prüfen wir dass die Marketing- und SEO-Pfade
  # noch antworten.
  # Eigener UA: curls Default-UA matcht den @scrapers-Filter im Standalone-
  # Caddyfile (403 auf allem außer /healthz + /readyz) — die Checks hier
  # prüfen aber gerade die Marketing-/SEO-Pfade.
  DEPLOY_CHECK_UA="auffi-deploy-check/1.0"
  check_url_status() {
    local url="$1"; local expected="$2"
    local got
    got=$(curl -s -A "${DEPLOY_CHECK_UA}" -o /dev/null -w "%{http_code}" --max-time 10 "${url}" || echo "000")
    if [[ "${got}" != "${expected}" ]]; then
      log_error "${url} → ${got} (expected ${expected})"
      return 1
    fi
    log_ok "${url} → ${got}"
  }
  check_url_status "https://${DEPLOY_DOMAIN}/" "200"
  check_url_status "https://${DEPLOY_DOMAIN}/healthz" "200"
  check_url_status "https://${DEPLOY_DOMAIN}/llms.txt" "200"
  check_url_status "https://${DEPLOY_DOMAIN}/robots.txt" "200"
  check_url_status "https://${DEPLOY_DOMAIN}/sitemap.xml" "200"
  # Smoke-Check unbekannter Pfad — Erwartung ist Mode-abhängig:
  #   Cluster: nginx/auffi-viewer.conf → try_files =404 → echte 404.
  #   Standalone: caddy/Caddyfile SPA-Fallback (try_files {path}
  #   /index.html) → 200 mit index.html.
  # URL OHNE führenden Dot, weil die Caddy-dotfile_protection-Regel
  # (siehe CLAUDE.md "Caddyfile Footguns") alle /. -Pfade mit 403 blockt.
  if [[ -n "${CLUSTER_PROXY:-}" ]]; then
    check_url_status "https://${DEPLOY_DOMAIN}/auffi-deploy-smoketest-$$" "404"
  else
    check_url_status "https://${DEPLOY_DOMAIN}/auffi-deploy-smoketest-$$" "200"
  fi
else
  log_dry "skip health checks in dry-run"
fi

# ---------------------------------------------------------------------------
# Step 16: Deploy-Log-Append (VOR dem Prune — der Prune nutzt das Log als
# Source-of-Truth für die zu behaltenden SHAs).
# ---------------------------------------------------------------------------
log_step "Deploy-Log-Append (${DEPLOY_LOG_REMOTE})"

maybe_run "Append deploy entry" \
  deploy_log_append "${APP_VERSION}" "${NOTES}"

# ---------------------------------------------------------------------------
# Step 17: Image-Prune auf prod (keep last-3-unique-SHAs aus deploy-log + :latest)
# Frühere Variante nutzte `docker images | tail -n +4` was bei ungenau
# definierter Sortierung gerne den JUST-deployten Tag erwischt hat (siehe
# Smoke 2026-05-20: nach Build prunte der Step den frischen :SHA gleich
# wieder, sodass --rollback auf diesen SHA scheiterte).
# ---------------------------------------------------------------------------
if [[ "${SKIP_IMAGE_PRUNE}" == "true" ]]; then
  log_step "Image-Prune übersprungen (--skip-image-prune)"
else
  log_step "Image-Prune (keep last 3 unique SHAs aus deploy-log + :latest)"
  maybe_run "Prune old backend images" \
    remote "set -e; \
      KEEP_LIST=\$(tail -n 20 '${DEPLOY_LOG_REMOTE}' 2>/dev/null \
        | awk -F'\t' '{print \$2}' \
        | awk '!seen[\$0]++' \
        | tail -n 3); \
      KEEP_REGEX='^latest$'; \
      for sha in \${KEEP_LIST}; do KEEP_REGEX=\"\${KEEP_REGEX}|^\${sha}$\"; done; \
      docker images --filter 'reference=auffi-backend' --format '{{.Tag}}' \
        | grep -E -v \"\${KEEP_REGEX}\" \
        | xargs -r -I{} docker rmi 'auffi-backend:{}' >/dev/null 2>&1 || true"
fi

# ---------------------------------------------------------------------------
# Step 18: Report
# ---------------------------------------------------------------------------
log_step "Deployment status"

if [[ "${DRY_RUN}" == "false" ]]; then
  remote_compose "ps"
  log_ok "Deployment von auffi ${APP_VERSION} fertig."
else
  log_dry "-- deploy complete (dry run) --"
fi
