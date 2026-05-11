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
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-screenie.mr-development.de}"
  DEPLOY_TURN_DOMAIN="${DEPLOY_TURN_DOMAIN:-turn.screenie.mr-development.de}"
}

# ---------------------------------------------------------------------------
# SSH / remote execution
# ---------------------------------------------------------------------------
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)

ssh_check() {
  # Returns 0 if the SSH target is reachable, 1 otherwise.
  ssh "${SSH_OPTS[@]}" "${DEPLOY_SSH}" "echo ok" >/dev/null 2>&1
}

remote() {
  # Run an arbitrary command on the remote host.
  ssh "${SSH_OPTS[@]}" "${DEPLOY_SSH}" "$@"
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
