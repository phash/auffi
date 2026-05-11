#!/usr/bin/env bash
# ops/health-check.sh — lightweight health check designed to run from cron.
#
# Usage:
#   ./ops/health-check.sh [--help]
#
# Cron example (every 5 minutes on the VPS):
#   */5 * * * * /opt/screenie/ops/health-check.sh >> /var/log/screenie-health.log 2>&1
#
# Can also be run from a dev box — it probes the public URLs, not the containers.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=ops/lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_deploy_env

if [[ "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $(basename "$0")

Probes /healthz and /readyz over HTTPS. Prints a timestamped summary.
Designed for cron (run every 5 minutes). Non-zero exit on any failure.
EOF
  exit 0
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FAILURES=0

# ---------------------------------------------------------------------------
# Probe helper
# ---------------------------------------------------------------------------
probe() {
  local url="$1"
  local response
  response="$(curl -fsS --max-time 5 "${url}" 2>/dev/null)" || {
    log_error "[${TIMESTAMP}] FAIL ${url} — connection error"
    FAILURES=$(( FAILURES + 1 ))
    return 1
  }
  log_ok "[${TIMESTAMP}] OK   ${url} — ${response}"
  return 0
}

# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------
probe "https://${DEPLOY_DOMAIN}/healthz" || true
probe "https://${DEPLOY_DOMAIN}/readyz"  || true

# ---------------------------------------------------------------------------
# Post result to MRD-API if credentials are available
# ---------------------------------------------------------------------------
if [[ -n "${MRD_API_KEY:-}" ]] && [[ -n "${MRD_CLUSTER_ID:-}" ]]; then
  STATE="operational"
  [[ "${FAILURES}" -gt 0 ]] && STATE="degraded"

  MRD_PAYLOAD="{\"state\":\"${STATE}\",\"checked_at\":\"${TIMESTAMP}\"}"

  CURL_STATUS="$(curl -fsS --max-time 10 \
    -X PUT \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${MRD_API_KEY}" \
    -d "${MRD_PAYLOAD}" \
    "https://www.mr-development.de/api/v1/external/clusters/${MRD_CLUSTER_ID}/status" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)" || CURL_STATUS="error"

  if [[ "${CURL_STATUS}" == "200" ]] || [[ "${CURL_STATUS}" == "204" ]]; then
    log_ok "[${TIMESTAMP}] MRD-API status posted: ${STATE}"
  else
    log_warn "[${TIMESTAMP}] MRD-API status post failed (HTTP ${CURL_STATUS}) — non-fatal"
  fi
fi

# ---------------------------------------------------------------------------
# Exit code
# ---------------------------------------------------------------------------
if [[ "${FAILURES}" -gt 0 ]]; then
  log_error "[${TIMESTAMP}] Health check FAILED (${FAILURES} probe(s) failed)"
  exit 1
fi

log_ok "[${TIMESTAMP}] All probes passed"
exit 0
