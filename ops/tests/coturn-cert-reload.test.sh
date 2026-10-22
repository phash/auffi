#!/usr/bin/env bash
# ops/tests/coturn-cert-reload.test.sh — coturn reads its TURNS cert only at
# startup; prod served an expired cert for 13 days because nothing told it
# about Caddy's renewal. Covers both halves of the fix:
#   coturn/entrypoint.sh  — renders the config, runs turnserver, forwards
#                           SIGTERM, reloads a changed cert via SIGUSR2 and
#                           restarts when a cert appears after a TLS-less start
#   coturn/cert-stage.sh  — the sidecar loop that re-copies a renewed cert
# turnserver is a fake that logs the signals it receives.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

COTURN_DIR="${OPS_DIR}/../coturn"
BIN="${TMP}/bin"
mkdir -p "${BIN}"

cat > "${BIN}/turnserver" <<'STUB'
#!/bin/sh
log="${FAKE_TURN_LOG}"
echo "start $*" >> "${log}"
trap 'echo USR2 >> "${log}"' USR2
trap 'echo TERM >> "${log}"; exit "${FAKE_TURN_EXIT_ON_TERM:-0}"' TERM
if [ -n "${FAKE_TURN_DIE_AFTER:-}" ]; then
  sleep "${FAKE_TURN_DIE_AFTER}"
  exit 3
fi
while :; do sleep 0.1; done
STUB
chmod +x "${BIN}/turnserver"

# wait_for <seconds> <command…> — poll until the command succeeds.
wait_for() {
  local deadline=$(( SECONDS + $1 )); shift
  until "$@"; do
    (( SECONDS < deadline )) || return 1
    sleep 0.1
  done
}

log_has() { grep -qx "$1" "${CASE}/turn.log" 2>/dev/null; }
count_in_log() { grep -cx "$1" "${CASE}/turn.log" 2>/dev/null || true; }
exited() { ! kill -0 "$1" 2>/dev/null; }

# start_entrypoint <case-dir> <template> — runs the entrypoint in the
# background with a 1 s poll; sets EP_PID.
start_entrypoint() {
  CASE="$1"
  mkdir -p "${CASE}/certs"
  : > "${CASE}/turn.log"
  PATH="${BIN}:${PATH}" \
    FAKE_TURN_LOG="${CASE}/turn.log" \
    TURN_SHARED_SECRET='s3/cr&t' TURN_REALM=turn.test \
    COTURN_CONF_TMPL="$2" COTURN_CONF_OUT="${CASE}/turnserver.conf" \
    TURN_CERT_FILE="${CASE}/certs/cert.pem" TURN_KEY_FILE="${CASE}/certs/key.pem" \
    TURN_CERT_POLL_SEC=1 \
    sh "${COTURN_DIR}/entrypoint.sh" 2> "${CASE}/entrypoint.err" &
  EP_PID=$!
  wait_for 5 log_has "start -c ${CASE}/turnserver.conf"
}

stop_entrypoint() {
  kill -TERM "${EP_PID}" 2>/dev/null || true
  wait "${EP_PID}" 2>/dev/null || true
}

write_pair() {
  printf '%s' "$2" > "$1/certs/cert.pem"
  printf '%s' "$3" > "$1/certs/key.pem"
}

TMPL="${COTURN_DIR}/turnserver.conf.tmpl"

# --- TLS active from the start; a renewed cert is hot-reloaded -------------
C="${TMP}/renew"; mkdir -p "${C}/certs"; write_pair "${C}" cert-1 key-1
start_entrypoint "${C}" "${TMPL}"
conf="$(cat "${C}/turnserver.conf")"
assert_contains "${conf}" "static-auth-secret=s3/cr&t" "secret substituted (sed-special chars survive)"
assert_contains "${conf}" "realm=turn.test" "realm substituted"
assert_contains "${conf}" "cert=/var/lib/turn/cert.pem" "TLS lines kept when the cert pair exists"
assert_not_contains "${conf}" "listening-ip=" "unset TURN_LISTENING_IP strips the line"

sleep 2.5
assert_eq "0" "$(count_in_log USR2)" "unchanged cert: no reload"

write_pair "${C}" cert-2 key-2
wait_for 6 log_has USR2 && ok=true || ok=false
assert_eq "true" "${ok}" "renewed cert triggers SIGUSR2"
sleep 3
assert_eq "1" "$(count_in_log USR2)" "one renewal = exactly one reload"

: > "${C}/certs/cert.pem"; : > "${C}/certs/key.pem"
sleep 3
assert_eq "1" "$(count_in_log USR2)" "an emptied pair is ignored (loaded cert stays)"
write_pair "${C}" cert-2 key-2
sleep 3
assert_eq "1" "$(count_in_log USR2)" "the pair coming back unchanged is no reload"

kill -TERM "${EP_PID}"
wait "${EP_PID}" && status=0 || status=$?
assert_eq "0" "${status}" "SIGTERM: entrypoint exits with turnserver's status"
assert_eq "1" "$(count_in_log TERM)" "SIGTERM forwarded to turnserver"

# --- started without a cert; the cert shows up later -----------------------
C="${TMP}/late"
start_entrypoint "${C}" "${TMPL}"
conf="$(cat "${C}/turnserver.conf")"
assert_not_contains "${conf}" "cert=" "no cert: cert= stripped"
assert_not_contains "${conf}" "tls-listening-port=" "no cert: TLS listener stripped"
assert_contains "$(cat "${C}/entrypoint.err")" "disabling TURNS" "no cert: logged"
write_pair "${C}" cert-1 key-1
wait_for 6 exited "${EP_PID}" && ok=true || ok=false
assert_eq "true" "${ok}" "cert appearing after a TLS-less start ends the container (restart policy re-renders with TLS)"
wait "${EP_PID}" && status=0 || status=$?
assert_eq "0" "${status}" "…with a clean exit"
assert_eq "1" "$(count_in_log TERM)" "…after stopping turnserver"
assert_eq "0" "$(count_in_log USR2)" "…not via a reload that cannot start a listener"

# --- template without TLS (smoke stack): a cert is no trigger --------------
C="${TMP}/notls"
start_entrypoint "${C}" "${COTURN_DIR}/turnserver.conf.notls.tmpl"
write_pair "${C}" cert-1 key-1
sleep 3
assert_eq "true" "$(kill -0 "${EP_PID}" 2>/dev/null && echo true || echo false)" "no-TLS template: cert appearing does not restart"
assert_eq "0" "$(count_in_log USR2)" "no-TLS template: no reload"
stop_entrypoint

# --- turnserver dies on its own --------------------------------------------
C="${TMP}/crash"; mkdir -p "${C}/certs"
FAKE_TURN_DIE_AFTER=1 start_entrypoint "${C}" "${TMPL}"
wait_for 5 exited "${EP_PID}" && ok=true || ok=false
assert_eq "true" "${ok}" "turnserver exit ends the entrypoint"
wait "${EP_PID}" && status=0 || status=$?
assert_eq "3" "${status}" "…passing its exit status on"

# --- cert-stage.sh ----------------------------------------------------------
S="${TMP}/stage"
mkdir -p "${S}/caddy/acme-v02.api.letsencrypt.org-directory/turn.test" "${S}/staged"
SRC="${S}/caddy/acme-v02.api.letsencrypt.org-directory/turn.test"
printf 'crt-1' > "${SRC}/turn.test.crt"
printf 'key-1' > "${SRC}/turn.test.key"
TURN_REALM=turn.test CADDY_CERT_ROOT="${S}/caddy" STAGE_DIR="${S}/staged" \
  STAGE_INTERVAL_SEC=1 STAGE_READY_MARKER="${S}/ready" \
  sh "${COTURN_DIR}/cert-stage.sh" 2> "${S}/stage.err" &
STAGE_PID=$!
wait_for 5 test -e "${S}/ready" && ok=true || ok=false
assert_eq "true" "${ok}" "stage: ready marker after the first pass"
assert_file_eq "${S}/staged/cert.pem" "crt-1" "stage: cert copied"
assert_file_eq "${S}/staged/key.pem" "key-1" "stage: key copied"
assert_eq "644" "$(stat -c '%a' "${S}/staged/key.pem")" "stage: key readable by coturn's unprivileged user"
inode="$(stat -c '%i' "${S}/staged/cert.pem")"
sleep 2.5
assert_eq "${inode}" "$(stat -c '%i' "${S}/staged/cert.pem")" "stage: unchanged source is not re-copied"

printf 'crt-2' > "${SRC}/turn.test.crt"
printf 'key-2' > "${SRC}/turn.test.key"
cert_is_2() { [[ "$(cat "${S}/staged/cert.pem")" == crt-2 ]]; }
wait_for 4 cert_is_2 && ok=true || ok=false
assert_eq "true" "${ok}" "stage: renewed cert re-copied by the loop"
assert_file_eq "${S}/staged/key.pem" "key-2" "stage: renewed key re-copied"

rm "${SRC}/turn.test.crt"
cert_empty() { [[ ! -s "${S}/staged/cert.pem" ]]; }
wait_for 4 cert_empty && ok=true || ok=false
assert_eq "true" "${ok}" "stage: missing source empties the staged pair"

kill -TERM "${STAGE_PID}"
wait_for 3 exited "${STAGE_PID}" && ok=true || ok=false
assert_eq "true" "${ok}" "stage: exits promptly on SIGTERM"

finish
