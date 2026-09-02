#!/usr/bin/env bash
# ops/maintenance.sh — multi-purpose maintenance tool.
#
# Usage:
#   ./ops/maintenance.sh <subcommand> [args]
#   ./ops/maintenance.sh --help

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=ops/lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_deploy_env

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
print_help() {
  cat <<EOF
Usage: $(basename "$0") <subcommand> [args]

Subcommands:
  status                  Show container status and last 50 log lines per service.
  logs [service]          Tail logs (all services or a specific one).
  restart [service]       Restart one service (or all if omitted).
  down                    Stop all services (volumes are NOT removed). Requires confirmation.
  up                      Start all services.
  backup                  Run the daily DB + caddy-data backup on prod (writes to /opt/backup/auffi/, 7-day retention).
  backup-certs            Tar up the turn-certs volume to /opt/backup/auffi/certs-<date>.tar.gz.
  cert-info               Show TLS certificate expiry for main and TURN domains.
  secret-rotate           Rotate TURN_SHARED_SECRET: generate new, update .env.prod, restart affected services.
  shell <service>         Drop into a shell in a running container.

Options:
  --help                  Show this help and exit.
EOF
}

if [[ $# -eq 0 ]] || [[ "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

SUBCOMMAND="$1"; shift

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
case "${SUBCOMMAND}" in

  status)
    log_step "Container status"
    remote_compose "ps"
    log_step "Recent logs (last 50 lines per service)"
    remote_compose "logs --tail 50"
    ;;

  logs)
    SERVICE="${1:-}"
    if [[ -n "${SERVICE}" ]]; then
      log_step "Logs for ${SERVICE}"
      remote_compose "logs -f --tail 100 ${SERVICE}"
    else
      log_step "Logs for all services"
      remote_compose "logs -f --tail 100"
    fi
    ;;

  restart)
    SERVICE="${1:-}"
    if [[ -n "${SERVICE}" ]]; then
      log_step "Restarting ${SERVICE}"
      remote_compose "restart ${SERVICE}"
      log_ok "${SERVICE} restarted"
    else
      log_step "Restarting all services"
      remote_compose "restart"
      log_ok "All services restarted"
    fi
    ;;

  down)
    log_warn "This will stop ALL auffi containers. Volumes are preserved."
    confirm "Stop all auffi services on ${DEPLOY_SSH}?"
    remote_compose "down --remove-orphans"
    log_ok "All services stopped"
    ;;

  up)
    log_step "Starting all services"
    remote_compose "up -d"
    wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 60
    log_ok "Services running"
    ;;

  backup)
    log_step "Running daily backup on ${DEPLOY_SSH}"
    # ops/backup.sh wird beim deploy mit nach DEPLOY_PATH transferiert.
    remote "${DEPLOY_PATH}/ops/backup.sh"
    log_ok "Backup finished — siehe /opt/backup/auffi/backup.log auf dem Host"
    ;;

  backup-certs)
    # Absoluter Pfad statt "~": Tilde in Quotes expandiert nie (die alte
    # Fassung legte ein literales `~`-Verzeichnis an), und Docker-Bind-
    # Mounts verlangen absolute Host-Pfade. Gleiches Zielverzeichnis-
    # Schema wie ops/backup.sh (/opt/backup/auffi).
    BACKUP_DIR="/opt/backup/auffi"
    DATE="$(date +%Y-%m-%d)"
    BACKUP_FILE="${BACKUP_DIR}/certs-${DATE}.tar.gz"
    # Volume-Prefix `screenie_` ergibt sich aus dem Compose-Project-Namen
    # (DEPLOY_PATH=/opt/screenie); siehe CLAUDE.md "Rebrand Naming
    # Inconsistencies". Im Cluster-Modus staged der turn-cert-stage-
    # Sidecar in `turn-certs-staged`; das standalone `turn-certs`-Volume
    # existiert dort nicht.
    CERT_VOLUME="screenie_turn-certs"
    [[ -n "${CLUSTER_PROXY:-}" ]] && CERT_VOLUME="screenie_turn-certs-staged"
    log_step "Backing up ${CERT_VOLUME} volume to ${BACKUP_FILE}"
    remote "mkdir -p '${BACKUP_DIR}'"
    remote "docker run --rm \
      -v ${CERT_VOLUME}:/certs:ro \
      -v '${BACKUP_DIR}':/backup \
      alpine:3.20 tar czf '/backup/certs-${DATE}.tar.gz' /certs"
    log_ok "Cert backup written to ${DEPLOY_SSH}:${BACKUP_FILE}"
    ;;

  cert-info)
    log_step "Certificate expiry for ${DEPLOY_DOMAIN}"
    echo | openssl s_client -servername "${DEPLOY_DOMAIN}" \
      -connect "${DEPLOY_DOMAIN}:443" 2>/dev/null \
      | openssl x509 -noout -dates 2>/dev/null || log_warn "Could not fetch cert for ${DEPLOY_DOMAIN}"

    log_step "Certificate expiry for ${DEPLOY_TURN_DOMAIN}"
    echo | openssl s_client -servername "${DEPLOY_TURN_DOMAIN}" \
      -connect "${DEPLOY_TURN_DOMAIN}:5349" 2>/dev/null \
      | openssl x509 -noout -dates 2>/dev/null || log_warn "Could not fetch cert for ${DEPLOY_TURN_DOMAIN}"
    ;;

  secret-rotate)
    log_step "Rotating TURN_SHARED_SECRET"
    NEW_SECRET="$(openssl rand -hex 32)"
    log_info "New secret generated (${#NEW_SECRET} hex chars)"

    log_info "Updating .env.prod on remote"
    remote "sed -i 's|^TURN_SHARED_SECRET=.*|TURN_SHARED_SECRET=${NEW_SECRET}|' '${DEPLOY_PATH}/.env.prod'"

    log_info "Restarting backend and coturn to pick up new secret"
    remote_compose "up -d --no-deps backend coturn"

    wait_healthy "https://${DEPLOY_DOMAIN}/healthz" 60
    log_ok "TURN_SHARED_SECRET rotated successfully"
    log_warn "Update TURN_SHARED_SECRET in your LOCAL .env.prod backup if you maintain one"
    ;;

  shell)
    SERVICE="${1:-}"
    if [[ -z "${SERVICE}" ]]; then
      log_error "Usage: maintenance.sh shell <service>"
      exit 1
    fi
    log_info "Opening shell in ${SERVICE} on ${DEPLOY_SSH}"
    # remote_compose_tty statt raw ssh: gleiche --env-file-/Cluster-Overlay-
    # Behandlung wie alle anderen Subcommands — sonst fehlt z.B. `shell
    # viewer` auf Cluster-Hosts der Service und compose warnt über unset
    # ${TURN_SHARED_SECRET} etc.
    remote_compose_tty "exec ${SERVICE} sh"
    ;;

  *)
    log_error "Unknown subcommand: ${SUBCOMMAND}"
    print_help
    exit 1
    ;;
esac
