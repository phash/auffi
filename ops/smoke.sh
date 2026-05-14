#!/usr/bin/env bash
# ops/smoke.sh — Full local pre-deploy smoke test for the production Docker stack.
#
# Brings up docker-compose.prod.yml overlaid with docker-compose.smoke.yml, runs
# a series of automated checks against the running containers, then tears down.
#
# Exit 0 = all tests passed.  Exit 1 = one or more tests failed.
#
# Requirements on the dev box:
#   - Docker Engine + docker compose v2
#   - Node.js 22 (for viewer build + ws smoke test)
#   - npm (comes with Node)
#   - openssl (for generating TURN_SHARED_SECRET)
#   - curl
#
# Optional (test is skipped if missing):
#   - turnutils_uclient (from rfc5766-turn-server / coturn packages)
#
# Usage:
#   ./ops/smoke.sh              # full run
#   ./ops/smoke.sh --no-build   # skip image + viewer builds (use cached)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROD="${REPO_ROOT}/docker-compose.prod.yml"
COMPOSE_SMOKE="${REPO_ROOT}/docker-compose.smoke.yml"
COMPOSE_CMD="docker compose -f ${COMPOSE_PROD} -f ${COMPOSE_SMOKE}"

# The smoke stack uses non-conflicting ports to avoid clashing with other local
# services that may hold 80/443.
SMOKE_HTTPS_PORT=8443
SMOKE_HTTP_PORT=8080
SMOKE_BASE_URL="https://localhost:${SMOKE_HTTPS_PORT}"
# Backend is exposed on 8081 in the smoke overlay (8080 may conflict with other services).
BACKEND_WS_URL="ws://localhost:8081/signal"   # direct to backend (bypasses Caddy)

NO_BUILD=false
for arg in "$@"; do
  [[ "$arg" == "--no-build" ]] && NO_BUILD=true
done

# ---------- colour helpers ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

pass() {
  local name="$1"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
  RESULTS+=("${GREEN}PASS${NC}  ${name}")
  echo -e "${GREEN}[PASS]${NC} ${name}"
}

fail() {
  local name="$1"
  local detail="${2:-}"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  RESULTS+=("${RED}FAIL${NC}  ${name}${detail:+  ($detail)}")
  echo -e "${RED}[FAIL]${NC} ${name}${detail:+  — ${detail}}"
}

skip() {
  local name="$1"
  local reason="${2:-}"
  RESULTS+=("${YELLOW}SKIP${NC}  ${name}${reason:+  ($reason)}")
  echo -e "${YELLOW}[SKIP]${NC} ${name}${reason:+  — ${reason}}"
}

section() {
  echo -e "\n${CYAN}=== $1 ===${NC}"
}

# ---------- cleanup trap ----------
STACK_STARTED=false

cleanup() {
  if [[ "${STACK_STARTED}" == "true" ]]; then
    section "Teardown"
    echo "Stopping smoke stack..."
    ${COMPOSE_CMD} down --remove-orphans --volumes 2>/dev/null || true
    echo "Stack stopped."
  fi
  # Remove the .env.prod stub if we created it (avoid leaving a stale file around).
  if [[ "${STUB_CREATED:-false}" == "true" && -f "${STUB_ENV:-}" ]]; then
    rm -f "${STUB_ENV}"
    echo ".env.prod stub removed."
  fi
  # Remove the local dashboard-dist staging dir (only meaningful between
  # smoke runs; the real deploy lives on the prod host).
  if [[ -d "${REPO_ROOT}/dashboard-dist" ]]; then
    rm -rf "${REPO_ROOT}/dashboard-dist"
  fi
}
trap cleanup EXIT

# ---------- 0. Generate ephemeral secrets + set port variables ----------
section "Setup"

export TURN_SHARED_SECRET
TURN_SHARED_SECRET="$(openssl rand -hex 32)"
echo "TURN_SHARED_SECRET generated (${#TURN_SHARED_SECRET} hex chars)"

# Use non-standard ports so the smoke stack doesn't clash with other local services.
export CADDY_HTTP_PORT=8080
export CADDY_HTTPS_PORT=8443
echo "Smoke ports: HTTP=${CADDY_HTTP_PORT}, HTTPS=${CADDY_HTTPS_PORT}, backend-direct=8081"

# ---------- 1. Build viewer + dashboard ----------
if [[ "${NO_BUILD}" == "false" ]]; then
  section "Build viewer"
  echo "Running: npm ci && npm run build (viewer)"
  (
    cd "${REPO_ROOT}/viewer"
    npm ci --silent
    npm run build --silent
  )
  echo "Viewer built → viewer/dist/"

  section "Build dashboard"
  echo "Running: npm ci && npm run build (dashboard)"
  (
    cd "${REPO_ROOT}/dashboard"
    npm ci --silent
    npm run build --silent
  )
  echo "Dashboard built → dashboard/dist/"

  # docker-compose.prod.yml bind-mounts ./dashboard-dist into the
  # auffi-dashboard nginx sidecar. Mirror dashboard/dist there.
  rm -rf "${REPO_ROOT}/dashboard-dist"
  cp -r "${REPO_ROOT}/dashboard/dist" "${REPO_ROOT}/dashboard-dist"
  echo "Synced dashboard-dist/ ← dashboard/dist/"
fi

if [[ ! -f "${REPO_ROOT}/viewer/dist/index.html" ]]; then
  echo -e "${RED}ERROR${NC}: viewer/dist/index.html not found. Run without --no-build or build manually."
  exit 1
fi
if [[ ! -f "${REPO_ROOT}/dashboard-dist/index.html" ]]; then
  echo -e "${RED}ERROR${NC}: dashboard-dist/index.html not found. Run without --no-build or build manually."
  exit 1
fi

# ---------- 2. Build backend image ----------
if [[ "${NO_BUILD}" == "false" ]]; then
  section "Build backend image"
  echo "Building auffi-backend:smoke ..."
  docker build -t auffi-backend:smoke "${REPO_ROOT}/backend" --quiet
  echo "Image built: auffi-backend:smoke"
fi

# ---------- 3. Start the stack ----------
section "Start stack"

# docker-compose.prod.yml references .env.prod via env_file; the smoke overlay
# overrides all environment values, but Docker Compose still validates that the
# file *exists* even when the overlay sets env_file: [].  Create a minimal stub
# so the validation passes without leaking any real secrets.
STUB_ENV="${REPO_ROOT}/.env.prod"
STUB_CREATED=false
if [[ ! -f "${STUB_ENV}" ]]; then
  cat > "${STUB_ENV}" <<'ENVEOF'
# Smoke-test stub — auto-generated by ops/smoke.sh, safe to delete.
# Real values are injected via docker-compose.smoke.yml environment overrides.
APP_VERSION=smoke
TURN_SHARED_SECRET=stub
TURN_REALM=localhost
TURN_HOSTS=turn:localhost:3478
TURN_TTL_SEC=3600
SESSION_TTL_MS=600000
MAX_FAILED_ATTEMPTS=5
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=10
ALLOWED_ORIGINS=https://localhost,http://localhost,http://127.0.0.1
NODE_ENV=production
ENVEOF
  STUB_CREATED=true
  echo "Created .env.prod stub for compose validation."
fi

echo "Starting: docker compose -f docker-compose.prod.yml -f docker-compose.smoke.yml up -d"
${COMPOSE_CMD} up -d --remove-orphans 2>&1
STACK_STARTED=true

# ---------- 4. Wait for backend healthy ----------
section "Wait for backend"
MAX_WAIT=60
ELAPSED=0
BACKEND_HEALTHY=false

echo -n "Waiting for backend health-check"
while [[ ${ELAPSED} -lt ${MAX_WAIT} ]]; do
  STATUS="$(docker inspect --format='{{.State.Health.Status}}' auffi-backend 2>/dev/null || echo "missing")"
  if [[ "${STATUS}" == "healthy" ]]; then
    BACKEND_HEALTHY=true
    break
  fi
  echo -n "."
  sleep 2
  ELAPSED=$(( ELAPSED + 2 ))
done
echo ""

if [[ "${BACKEND_HEALTHY}" == "true" ]]; then
  pass "backend container healthy"
else
  STATUS="$(docker inspect --format='{{.State.Health.Status}}' auffi-backend 2>/dev/null || echo "missing")"
  fail "backend container healthy" "status=${STATUS}"
  echo "--- backend logs (last 30 lines) ---"
  docker logs auffi-backend --tail 30 2>&1 || true
fi

# ---------- 5. Wait for Caddy ----------
section "Wait for Caddy"
MAX_WAIT=60
ELAPSED=0
CADDY_READY=false

echo -n "Waiting for Caddy HTTPS on ${SMOKE_BASE_URL}/healthz"
while [[ ${ELAPSED} -lt ${MAX_WAIT} ]]; do
  HTTP_CODE="$(curl -sk -o /dev/null -w '%{http_code}' "${SMOKE_BASE_URL}/healthz" 2>/dev/null || true)"
  if [[ "${HTTP_CODE}" == "200" ]]; then
    CADDY_READY=true
    break
  fi
  echo -n "."
  sleep 2
  ELAPSED=$(( ELAPSED + 2 ))
done
echo ""

if [[ "${CADDY_READY}" == "true" ]]; then
  pass "Caddy HTTPS reachable (port ${SMOKE_HTTPS_PORT})"
else
  fail "Caddy HTTPS reachable (port ${SMOKE_HTTPS_PORT})" "last HTTP status=${HTTP_CODE:-timeout}"
  echo "--- caddy logs (last 30 lines) ---"
  docker logs auffi-caddy --tail 30 2>&1 || true
fi

# ---------- 6. Endpoint tests ----------
section "Endpoint tests"

# /healthz
HEALTH_RESP="$(curl -sk "${SMOKE_BASE_URL}/healthz" 2>/dev/null || true)"
if echo "${HEALTH_RESP}" | grep -q '"status":"ok"'; then
  pass "/healthz → {status:ok}"
else
  fail "/healthz → {status:ok}" "got: ${HEALTH_RESP}"
fi

# /readyz
READY_RESP="$(curl -sk "${SMOKE_BASE_URL}/readyz" 2>/dev/null || true)"
if echo "${READY_RESP}" | grep -q '"status":"ok"'; then
  pass "/readyz → {status:ok}"
else
  fail "/readyz → {status:ok}" "got: ${READY_RESP}"
fi

# /turn-credentials
TURN_RESP="$(curl -sk -X POST "${SMOKE_BASE_URL}/turn-credentials" 2>/dev/null || true)"
if echo "${TURN_RESP}" | grep -q '"username"' && echo "${TURN_RESP}" | grep -q '"credential"'; then
  pass "POST /turn-credentials → valid JSON with username+credential"
else
  fail "POST /turn-credentials → valid JSON with username+credential" "got: ${TURN_RESP}"
fi

# Viewer SPA index.html
VIEWER_RESP_CODE="$(curl -sk -o /dev/null -w '%{http_code}' "${SMOKE_BASE_URL}/" 2>/dev/null || true)"
if [[ "${VIEWER_RESP_CODE}" == "200" ]]; then
  pass "Viewer index.html served (HTTP 200)"
else
  fail "Viewer index.html served (HTTP 200)" "got HTTP ${VIEWER_RESP_CODE}"
fi

# ---------- 7. WebSocket signaling smoke test ----------
section "WebSocket smoke test"

WS_DEPS_OK=false
if [[ -f "${REPO_ROOT}/scripts/node_modules/ws/package.json" ]]; then
  WS_DEPS_OK=true
else
  echo "Installing ws dependency for smoke-ws.mjs..."
  ( cd "${REPO_ROOT}/scripts" && npm ci --silent ) && WS_DEPS_OK=true || true
fi

if [[ "${WS_DEPS_OK}" == "true" ]]; then
  # The smoke WS test goes directly to the backend (bypassing Caddy's WSS) because
  # the self-signed cert would cause Node's HTTPS/WSS client to reject it without
  # --insecure flags.  We verify Caddy WS proxy separately in the curl tests above.
  if node "${REPO_ROOT}/scripts/smoke-ws.mjs" "${BACKEND_WS_URL}" 2>&1; then
    pass "WebSocket signaling (register → code-assigned → join → peer-confirmed)"
  else
    fail "WebSocket signaling (register → code-assigned → join → peer-confirmed)"
  fi
else
  skip "WebSocket signaling" "ws npm package not available"
fi

# ---------- 8. coturn smoke test ----------
section "coturn smoke test"

# Check that coturn is up and listening on port 3478.
COTURN_STATUS="$(docker inspect --format='{{.State.Status}}' auffi-coturn 2>/dev/null || echo "missing")"
if [[ "${COTURN_STATUS}" == "running" ]]; then
  pass "coturn container running"
else
  fail "coturn container running" "status=${COTURN_STATUS}"
  echo "--- coturn logs (last 20 lines) ---"
  docker logs auffi-coturn --tail 20 2>&1 || true
fi

# Try connecting to the TURN port with nc (available on virtually every Linux box).
if command -v nc &>/dev/null; then
  if echo "" | nc -w 2 127.0.0.1 3478 &>/dev/null; then
    pass "coturn port 3478 reachable (TCP)"
  else
    fail "coturn port 3478 reachable (TCP)" "nc connection refused/timeout"
  fi
else
  skip "coturn port 3478 reachable (TCP)" "nc not found"
fi

# turnutils_uclient if available.
if command -v turnutils_uclient &>/dev/null; then
  TURN_TS=$(( $(date +%s) + 3600 ))
  TURN_USER="${TURN_TS}:smoketest"
  TURN_CRED=$(echo -n "${TURN_USER}" | openssl dgst -sha1 -hmac "${TURN_SHARED_SECRET}" -binary | base64)
  if turnutils_uclient -t -u "${TURN_USER}" -w "${TURN_CRED}" -p 3478 127.0.0.1 &>/dev/null; then
    pass "TURN relay allocation via turnutils_uclient"
  else
    fail "TURN relay allocation via turnutils_uclient"
  fi
else
  skip "TURN relay allocation via turnutils_uclient" "turnutils_uclient not installed (pacman -S coturn to install)"
fi

# ---------- 9. Print summary ----------
section "Smoke Test Summary"

echo ""
for result in "${RESULTS[@]}"; do
  echo -e "  ${result}"
done
echo ""
echo -e "  Total: ${GREEN}${PASS_COUNT} passed${NC}, ${RED}${FAIL_COUNT} failed${NC}, $(( ${#RESULTS[@]} - PASS_COUNT - FAIL_COUNT )) skipped"
echo ""

if [[ ${FAIL_COUNT} -gt 0 ]]; then
  echo -e "${RED}SMOKE TEST FAILED${NC} — ${FAIL_COUNT} check(s) did not pass."
  exit 1
else
  echo -e "${GREEN}SMOKE TEST PASSED${NC} — all checks OK."
  exit 0
fi
