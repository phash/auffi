#!/usr/bin/env bash
# ops/health-check.sh — lightweight health check designed to run from cron.
#
# Usage:
#   ./ops/health-check.sh [--help]
#
# Deploy: ops/deploy.sh Step 10 shippt dieses Skript (+ lib.sh) nach
# ${DEPLOY_PATH}/ops/ auf den VPS. Cron dort einrichten (alle 5 Minuten):
#   */5 * * * * /opt/screenie/ops/health-check.sh >> /var/log/screenie-health.log 2>&1
#
# MRD-API-Reporting (optional): MRD_API_KEY + MRD_CLUSTER_ID entweder in
# der Crontab-Environment setzen oder in /opt/screenie/.env.prod ablegen —
# das Skript liest die beiden Keys gezielt aus ../.env.prod (siehe unten).
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
# ops/README § 9 dokumentiert MRD_* in ${DEPLOY_PATH}/.env.prod (liegt auf
# dem VPS neben ops/). Nur die zwei Keys gezielt herausgreifen statt die
# Datei zu sourcen — .env.prod enthält Secrets mit potentiellen
# Shell-Metazeichen (SMTP_PASS etc.), die `source` brechen würden.
ENV_PROD_FILE="${SCRIPT_DIR}/../.env.prod"
if [[ -f "${ENV_PROD_FILE}" ]]; then
  # `|| true`: fehlende Keys sind legitim (Reporting optional) — ohne das
  # würde set -e -o pipefail das Skript am erfolglosen grep beenden.
  MRD_API_KEY="${MRD_API_KEY:-$(grep -E '^MRD_API_KEY=' "${ENV_PROD_FILE}" | tail -n 1 | cut -d= -f2- || true)}"
  MRD_CLUSTER_ID="${MRD_CLUSTER_ID:-$(grep -E '^MRD_CLUSTER_ID=' "${ENV_PROD_FILE}" | tail -n 1 | cut -d= -f2- || true)}"
fi

if [[ -n "${MRD_API_KEY:-}" ]] && [[ -n "${MRD_CLUSTER_ID:-}" ]]; then
  STATE="operational"
  [[ "${FAILURES}" -gt 0 ]] && STATE="degraded"

  MRD_CLUSTER_URL="https://www.mr-development.de/api/v1/external/clusters/${MRD_CLUSTER_ID}"

  # PUT /clusters/:id/status erwartet {"status": {…}} — ein Record, dessen
  # Keys die Projekte auf dem Cluster sind (jeder Wert ein freier Text).
  # Ein flaches {"state": …} bekommt VALIDATION_ERROR, und weil der Post
  # non-fatal ist, fiel das monatelang nicht auf. Der Record wird per GET
  # geholt und nur unser Key ersetzt, damit ein PUT die Einträge der
  # anderen Projekte nicht überschreibt.
  MRD_CURRENT="$(curl -fsS --max-time 10 -H "X-API-Key: ${MRD_API_KEY}" "${MRD_CLUSTER_URL}" 2>/dev/null || true)"
  MRD_PAYLOAD="$(printf '%s' "${MRD_CURRENT}" | python3 -c '
import json, sys
state, checked = sys.argv[1], sys.argv[2]
try:
    doc = json.load(sys.stdin)
except ValueError:
    doc = {}
cluster = doc.get("data", doc) if isinstance(doc, dict) else {}
status = cluster.get("status") if isinstance(cluster, dict) else None
if not isinstance(status, dict):
    status = {}
status["auffi"] = f"{state} — healthz+readyz checked {checked}"
print(json.dumps({"status": status}))
' "${STATE}" "${TIMESTAMP}")"

  MRD_RESULT="$(curl -sS --max-time 10 \
    -X PUT \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${MRD_API_KEY}" \
    -d "${MRD_PAYLOAD}" \
    -w $'\n%{http_code}' \
    "${MRD_CLUSTER_URL}/status" 2>/dev/null)" || MRD_RESULT=$'\nerror'
  CURL_STATUS="${MRD_RESULT##*$'\n'}"
  MRD_BODY="${MRD_RESULT%$'\n'*}"

  if [[ "${CURL_STATUS}" == "200" ]] || [[ "${CURL_STATUS}" == "204" ]]; then
    log_ok "[${TIMESTAMP}] MRD-API status posted: ${STATE}"
  else
    log_warn "[${TIMESTAMP}] MRD-API status post failed (HTTP ${CURL_STATUS}) — non-fatal. Response: ${MRD_BODY}"
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
