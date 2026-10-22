#!/bin/sh
# turn-cert-stage sidecar (docker-compose.cluster.yml): copies the Caddy-
# issued cert + key for the TURN subdomain from the cluster Caddy's data
# volume into the small volume coturn reads as its unprivileged user.
#
# Long-running on purpose: Caddy renews the cert in place, and a one-shot
# copy at `compose up` let prod serve an expired TURNS cert from 2026-10-09
# until a manual restart on 2026-10-22. Every STAGE_INTERVAL_SEC the pair is
# re-copied if (and only if) its content changed; coturn's entrypoint picks
# the change up and reloads. No docker socket needed anywhere.
set -eu

: "${TURN_REALM:?TURN_REALM must be set}"
SRC_ROOT="${CADDY_CERT_ROOT:-/caddy-data/caddy/certificates}"
STAGED="${STAGE_DIR:-/staged}"
INTERVAL="${STAGE_INTERVAL_SEC:-21600}"
READY_MARKER="${STAGE_READY_MARKER:-/tmp/staged-once}"

log() {
  echo "[turn-cert-stage] $*" >&2
}

# Copy via a temp file + rename so coturn never reads a half-written file.
install_if_changed() {
  src="$1"
  dst="$2"
  if cmp -s "${src}" "${dst}"; then
    return 1
  fi
  cp "${src}" "${dst}.new"
  chmod 644 "${dst}.new"
  mv -f "${dst}.new" "${dst}"
}

stage() {
  src_dir="$(find "${SRC_ROOT}" -type d -name "${TURN_REALM}" 2>/dev/null | head -n1)"
  crt="${src_dir}/${TURN_REALM}.crt"
  key="${src_dir}/${TURN_REALM}.key"
  if [ -n "${src_dir}" ] && [ -s "${crt}" ] && [ -s "${key}" ]; then
    changed=false
    install_if_changed "${crt}" "${STAGED}/cert.pem" && changed=true
    install_if_changed "${key}" "${STAGED}/key.pem" && changed=true
    if [ "${changed}" = true ]; then
      log "staged cert and key from ${src_dir}"
    fi
  else
    log "no cert found for ${TURN_REALM}; TURNS stays disabled until Caddy issues one"
    # Empty (not stale) files make coturn's entrypoint disable TLS cleanly;
    # a running coturn ignores an empty pair and keeps its loaded cert.
    : > "${STAGED}/cert.pem"
    : > "${STAGED}/key.pem"
  fi
}

# PID 1 ignores SIGTERM without a handler — without this trap every
# `compose down` would wait out the 10 s kill timeout.
trap 'exit 0' TERM INT

stage
: > "${READY_MARKER}"

while :; do
  sleep "${INTERVAL}" &
  wait $! || true
  stage
done
