#!/usr/bin/env bash
# ops/lib.sh — shared helpers for all ops scripts.
# Source this file: source "$(dirname "$0")/lib.sh"
set -euo pipefail

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
_RED='\033[0;31m'
_GREEN='\033[0;32m'
_YELLOW='\033[1;33m'
_CYAN='\033[0;36m'
_BOLD='\033[1m'
_RESET='\033[0m'

log_info()    { printf "${_CYAN}[deploy]${_RESET}  %s\n" "$*"; }
log_ok()      { printf "${_GREEN}[deploy]${_RESET}  %s\n" "$*"; }
log_warn()    { printf "${_YELLOW}[deploy]${_RESET}  %s\n" "$*" >&2; }
log_error()   { printf "${_RED}[deploy]${_RESET}  ERROR: %s\n" "$*" >&2; }
log_step()    { printf "\n${_BOLD}==> %s${_RESET}\n" "$*"; }
log_dry()     { printf "${_YELLOW}[dry-run]${_RESET} %s\n" "$*"; }

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------
load_deploy_env() {
  local env_file
  env_file="$(dirname "$(realpath "$0")")/.env.deploy"
  if [[ -f "${env_file}" ]]; then
    log_info "Loading deploy env from ${env_file}"
    # shellcheck source=/dev/null
    set -a; source "${env_file}"; set +a
  else
    log_warn ".env.deploy not found — relying on environment variables"
  fi

  DEPLOY_SSH="${DEPLOY_SSH:-musikersuche@musikersuche.org}"
  DEPLOY_PATH="${DEPLOY_PATH:-/opt/screenie}"
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-auffi.app}"
  DEPLOY_TURN_DOMAIN="${DEPLOY_TURN_DOMAIN:-turn.auffi.app}"
  build_ssh_opts
}

# ---------------------------------------------------------------------------
# SSH / remote execution
# ---------------------------------------------------------------------------
# Host key pinned to ops/known_hosts (committed; self-hosters replace it with
# `ssh-keyscan <host>` after checking the fingerprint out-of-band, or point
# DEPLOY_KNOWN_HOSTS elsewhere). `accept-new` would trust whatever key the
# first connection from a fresh workstation or CI runner presents — under a
# DNS hijack that is the attacker's host receiving the image tarball, the
# .env.prod edits and the rsync payloads without a single prompt.
_OPS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_ssh_opts() {
  # Re-run by load_deploy_env: ops/.env.deploy may set DEPLOY_KNOWN_HOSTS,
  # and it is sourced after this file.
  DEPLOY_KNOWN_HOSTS="${DEPLOY_KNOWN_HOSTS:-${_OPS_LIB_DIR}/known_hosts}"
  SSH_OPTS=(-o "UserKnownHostsFile=${DEPLOY_KNOWN_HOSTS}" -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o BatchMode=yes)
}
build_ssh_opts

ssh_check() {
  # Returns 0 if the SSH target is reachable, 1 otherwise.
  ssh "${SSH_OPTS[@]}" "${DEPLOY_SSH}" "echo ok" >/dev/null 2>&1
}

remote() {
  # Run an arbitrary command on the remote host.
  ssh "${SSH_OPTS[@]}" "${DEPLOY_SSH}" "$@"
}

remote_tty() {
  # Wie remote(), aber mit forciertem TTY-Allocate (-tt) — nötig für
  # interaktive Kommandos wie `docker compose exec <svc> sh`, die ohne
  # TTY sofort mit EOF beenden.
  ssh -tt "${SSH_OPTS[@]}" "${DEPLOY_SSH}" "$@"
}

remote_compose() {
  # Run docker compose on the remote host inside DEPLOY_PATH.
  # --env-file .env.prod feeds variable interpolation in docker-compose.prod.yml
  # (e.g. ${TURN_SHARED_SECRET}, ${APP_VERSION}); per-service env_file: stanzas
  # are independent and continue to inject runtime env into containers.
  # CLUSTER_PROXY adds docker-compose.cluster.yml overlay (disables internal
  # Caddy, attaches backend to the external proxy network).
  local cluster_flag=""
  [[ -n "${CLUSTER_PROXY:-}" ]] && cluster_flag="-f docker-compose.cluster.yml"
  remote "cd ${DEPLOY_PATH} && docker compose --env-file .env.prod -f docker-compose.prod.yml ${cluster_flag} $*"
}

remote_compose_tty() {
  # Wie remote_compose(), aber über remote_tty — für `exec`-Subcommands,
  # die ein interaktives Terminal brauchen. Identische Overlay-/env-file-
  # Behandlung, damit z.B. `shell viewer` auch auf Cluster-Hosts den
  # Service findet und keine Unset-Variable-Warnungen entstehen.
  local cluster_flag=""
  [[ -n "${CLUSTER_PROXY:-}" ]] && cluster_flag="-f docker-compose.cluster.yml"
  remote_tty "cd ${DEPLOY_PATH} && docker compose --env-file .env.prod -f docker-compose.prod.yml ${cluster_flag} $*"
}

rsync_to() {
  # rsync_to <local-src> <remote-dest> [extra-rsync-flags...]
  local src="$1"; local dest="$2"; shift 2
  rsync -az --progress \
    -e "ssh ${SSH_OPTS[*]}" \
    "$@" \
    "${src}" \
    "${DEPLOY_SSH}:${dest}"
}

# ---------------------------------------------------------------------------
# Health polling
# ---------------------------------------------------------------------------
wait_healthy() {
  # wait_healthy <url> [timeout_seconds=60]
  local url="$1"
  local timeout="${2:-60}"
  local elapsed=0
  local interval=3
  log_info "Waiting for ${url} to return HTTP 200 (timeout ${timeout}s)…"
  while [[ ${elapsed} -lt ${timeout} ]]; do
    if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
      log_ok "${url} is healthy"
      return 0
    fi
    sleep ${interval}
    elapsed=$(( elapsed + interval ))
  done
  log_error "${url} did not become healthy within ${timeout}s"
  return 1
}

# ---------------------------------------------------------------------------
# Confirmation prompt
# ---------------------------------------------------------------------------
confirm() {
  # confirm <message> — exits if user does not confirm.
  local msg="${1:-Are you sure?}"
  read -rp "${msg} [y/N] " answer
  case "${answer}" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) log_warn "Aborted."; exit 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# Dry-run support
# ---------------------------------------------------------------------------
DRY_RUN=false

maybe_run() {
  # maybe_run <description> <cmd...>
  # In dry-run mode, prints what would run. Otherwise executes it.
  local desc="$1"; shift
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_dry "${desc}"
    log_dry "  cmd: $*"
  else
    log_info "${desc}"
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Concurrency lock — eine Deploy-Instanz gleichzeitig.
# Nutzt flock auf einem festen Pfad in /tmp. FD 9 ist arbiträr aber
# stabil; im Subshell-Trap weiter unten wird er nicht freigegeben, das
# erledigt der Kernel beim Exit des Skript-Prozesses.
# ---------------------------------------------------------------------------
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/auffi-deploy.lock}"

acquire_deploy_lock() {
  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    log_dry "acquire_deploy_lock (skipped in dry-run)"
    return 0
  fi
  exec 9>"${DEPLOY_LOCK_FILE}"
  if ! flock -n 9; then
    log_error "Another deploy is in progress (lock: ${DEPLOY_LOCK_FILE}). Wait or remove the lock if stale."
    exit 1
  fi
  log_info "Acquired deploy lock (${DEPLOY_LOCK_FILE})"
}

# ---------------------------------------------------------------------------
# Cleanup-Register — Files die ein Trap beim Exit aufräumen soll.
# Wird primär für lokale Image-Tarballs verwendet, die bei einem Abort
# sonst in /tmp leaken.
# ---------------------------------------------------------------------------
CLEANUP_FILES=()
register_cleanup_file() {
  CLEANUP_FILES+=("$1")
}

_do_cleanup() {
  local rc=$?
  for f in "${CLEANUP_FILES[@]:-}"; do
    [[ -n "${f}" ]] && rm -f "${f}" 2>/dev/null || true
  done
  return "${rc}"
}

install_cleanup_trap() {
  trap _do_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# ---------------------------------------------------------------------------
# Hash-basierter File-Diff zwischen lokalem File und Remote-Pfad.
# Returns 0 (true) wenn sich etwas geändert hat ODER Remote-File fehlt.
# Returns 1 (false) wenn identisch.
# ---------------------------------------------------------------------------
file_changed_on_remote() {
  local local_file="$1"
  local remote_file="$2"
  if [[ ! -f "${local_file}" ]]; then
    log_warn "Local file missing: ${local_file}"
    return 0
  fi
  local local_hash remote_hash
  local_hash=$(sha256sum "${local_file}" | awk '{print $1}')
  remote_hash=$(remote "sha256sum '${remote_file}' 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)
  [[ "${local_hash}" != "${remote_hash}" ]]
}

# ---------------------------------------------------------------------------
# Lokale Config-Validation via ephemere Container.
# nginx_validate_local validiert einen einzelnen conf-Snippet, der ins
# default /etc/nginx/conf.d/ gemountet wird. caddy_validate_local nimmt
# einen kompletten Caddyfile.
# ---------------------------------------------------------------------------
nginx_validate_local() {
  local conf_file="$1"
  if [[ ! -f "${conf_file}" ]]; then
    log_error "nginx validate: file not found: ${conf_file}"
    return 1
  fi
  local out
  if ! out=$(docker run --rm \
      -v "${conf_file}:/etc/nginx/conf.d/default.conf:ro" \
      nginx:1.29-alpine nginx -t 2>&1); then
    log_error "nginx -t failed for ${conf_file}:"
    printf '%s\n' "${out}" >&2
    return 1
  fi
  log_ok "nginx -t ok: $(basename "${conf_file}")"
}

caddy_validate_local() {
  local caddyfile="$1"
  if [[ ! -f "${caddyfile}" ]]; then
    log_error "caddy validate: file not found: ${caddyfile}"
    return 1
  fi
  # caddy/Caddyfile nutzt das rate_limit-Plugin — stock caddy kennt die
  # Directive nicht und würde die Validation (und den Container) an einer
  # gültigen Config scheitern lassen. Deshalb mit demselben Plugin-Image
  # validieren, das docker-compose.prod.yml baut (caddy/Dockerfile liegt
  # neben dem Caddyfile). Ohne Dockerfile daneben: Fallback aufs
  # Stock-Image (z.B. für ein plugin-freies Caddyfile.local).
  local caddy_dir image out
  caddy_dir="$(cd "$(dirname "${caddyfile}")" && pwd)"
  image="caddy:2.11.2-alpine"
  if [[ -f "${caddy_dir}/Dockerfile" ]]; then
    image="auffi-caddy:validate"
    if ! out=$(docker build -q -t "${image}" "${caddy_dir}" 2>&1); then
      log_error "caddy validate: build of ${caddy_dir}/Dockerfile failed:"
      printf '%s\n' "${out}" >&2
      return 1
    fi
  fi
  if ! out=$(docker run --rm \
      -v "${caddyfile}:/etc/caddy/Caddyfile:ro" \
      "${image}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    log_error "caddy validate failed for ${caddyfile}:"
    printf '%s\n' "${out}" >&2
    return 1
  fi
  log_ok "caddy validate ok: $(basename "${caddyfile}") (image ${image})"
}

# ---------------------------------------------------------------------------
# Remote-Image-Check — true wenn ${tag} schon als geladenes Image existiert.
# Wird verwendet um Build + Transfer zu überspringen wenn nichts neues da ist.
# ---------------------------------------------------------------------------
remote_image_exists() {
  local image="$1"
  remote "docker image inspect '${image}' >/dev/null 2>&1"
}

# ---------------------------------------------------------------------------
# Release-Snapshots — pro deployter SHA eine Kopie der bind-gemounteten
# Assets (viewer-dist, dashboard-dist, nginx/, coturn/, standalone auch
# caddy/) unter ${DEPLOY_PATH}/releases/<sha>/. Das Backend-Image trägt
# seine SHA selbst; die Frontends und Configs tun das nicht — ohne Snapshot
# kann --rollback nur das Image zurücksetzen und lässt eine Frontend-/
# Config-Regression live (docs/ops-runbook.md § Rollback).
# caddy/ nur standalone: im Cluster-Modus ist /opt/caddyserver/Caddyfile
# hand-gepflegt und ${DEPLOY_PATH}/caddy wird gar nicht deployed
# (docs/footguns.md § Cluster-Ops).
# ---------------------------------------------------------------------------
release_dir() {
  echo "${DEPLOY_PATH}/releases/$1"
}

release_assets() {
  printf '%s\n' viewer-dist dashboard-dist nginx coturn
  [[ -z "${CLUSTER_PROXY:-}" ]] && printf '%s\n' caddy
  return 0
}

remote_release_exists() {
  remote "test -d '$(release_dir "$1")'"
}

release_snapshot() {
  # release_snapshot <sha> — Assets aus ${DEPLOY_PATH} nach releases/<sha>/.
  local sha="$1" dir asset
  dir="$(release_dir "${sha}")"
  for asset in $(release_assets); do
    remote "if [ -d '${DEPLOY_PATH}/${asset}' ]; then mkdir -p '${dir}/${asset}' && rsync -a --delete '${DEPLOY_PATH}/${asset}/' '${dir}/${asset}/'; fi"
  done
}

release_restore() {
  # release_restore <sha> — releases/<sha>/ zurück nach ${DEPLOY_PATH}.
  local sha="$1" dir asset
  dir="$(release_dir "${sha}")"
  for asset in $(release_assets); do
    remote "if [ -d '${dir}/${asset}' ]; then mkdir -p '${DEPLOY_PATH}/${asset}' && rsync -a --delete '${dir}/${asset}/' '${DEPLOY_PATH}/${asset}/'; fi"
  done
}

# ---------------------------------------------------------------------------
# viewer/dist → viewer-dist/ mit --delete, aber ohne den Flat-Hosting-
# Altbestand unter /download/ zu löschen: install-linux.sh + latest.txt
# (von INSTALL-LINUX.md verlinkt, live 200) und alte Installer liegen nur
# auf dem Host, nicht im Build. Von deploy.sh UND update.sh benutzt — bis
# 0.7.1 hatte nur deploy.sh die Excludes, ein Hotfix via update.sh
# löschte genau diese Dateien. Kein *.dmg — es gibt keinen macOS-Build.
# ---------------------------------------------------------------------------
VIEWER_DIST_RSYNC_EXCLUDES=(
  --exclude=/download/*.deb
  --exclude=/download/*.rpm
  --exclude=/download/*.AppImage
  --exclude=/download/*.msi
  --exclude=/download/*.exe
  --exclude=/download/*.sh
  --exclude=/download/latest.txt
)

rsync_viewer_dist() {
  # rsync_viewer_dist <local-dist/> <remote-viewer-dist/>
  rsync_to "$1" "$2" --delete "${VIEWER_DIST_RSYNC_EXCLUDES[@]}"
}

# ---------------------------------------------------------------------------
# Standalone only: Caddy served den Viewer aus dem viewer-static-Volume,
# nicht aus dem Bind-Mount. Volume-Name `screenie_viewer-static`: das
# Compose-Project auf prod heißt `screenie` (DEPLOY_PATH=/opt/screenie,
# s. docs/ops-runbook.md Rebrand-Notizen) — ein falscher Prefix würde von
# `docker run -v` still als neues, von Caddy nie gelesenes Volume angelegt.
# ---------------------------------------------------------------------------
populate_viewer_static_volume() {
  remote "docker run --rm \
    -v screenie_viewer-static:/data \
    -v '${DEPLOY_PATH}/viewer-dist':/src:ro \
    busybox:1.36.1 sh -c 'cp -a /src/. /data/'"
}

# ---------------------------------------------------------------------------
# HTTP-Status-Check für die Post-Deploy-/Post-Rollback-Smoke-Checks.
# Eigener UA: curls Default-UA matcht den @scrapers-Filter im Standalone-
# Caddyfile (403 auf allem außer /healthz + /readyz) — geprüft werden hier
# aber gerade die Marketing-/SEO-Pfade.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Deploy-Log — append-only Datei auf prod mit Geschichte aller Deploys.
# Format pro Zeile: ISO8601-UTC TAB sha TAB deployer TAB notes
# ---------------------------------------------------------------------------
DEPLOY_LOG_REMOTE="${DEPLOY_LOG_REMOTE:-${DEPLOY_PATH:-/opt/screenie}/.deploy-log}"

deploy_log_append() {
  local sha="$1"
  local notes="${2:-}"
  local who; who="$(whoami)@$(hostname -s)"
  local stamp; stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Tab-separated. Notes: tab/newline/single-quote stripped — letzteres
  # damit die remote single-quote-Quoting nicht bricht.
  local clean_notes; clean_notes=$(printf '%s' "${notes}" | tr -d "\t\n'")
  local line; line=$(printf '%s\t%s\t%s\t%s' "${stamp}" "${sha}" "${who}" "${clean_notes}")
  remote "printf '%s\n' '${line}' >> '${DEPLOY_LOG_REMOTE}'"
}

deploy_log_last_sha() {
  # Echo'd auf stdout; leer wenn kein Log existiert oder leer ist.
  remote "tail -n 1 '${DEPLOY_LOG_REMOTE}' 2>/dev/null | awk -F'\t' '{print \$2}'" || true
}

deploy_log_previous_sha() {
  # Vorletzte Zeile — für Rollback.
  remote "tail -n 2 '${DEPLOY_LOG_REMOTE}' 2>/dev/null | head -n 1 | awk -F'\t' '{print \$2}'" || true
}

remote_env_app_version() {
  # APP_VERSION aus dem Remote-.env.prod — der SHA, den compose gerade
  # tatsächlich fährt. Weicht er vom letzten Deploy-Log-Eintrag ab, ist
  # der letzte Deploy VOR dem Log-Append gescheitert (Health-Check-Abort
  # nach Step 13) und der Log-Tail ist bereits der letzte GUTE SHA.
  remote "grep -E '^APP_VERSION=' '${DEPLOY_PATH}/.env.prod' 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\"'" || true
}
