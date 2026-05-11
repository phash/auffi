#!/bin/sh
set -eu

: "${TURN_SHARED_SECRET:?TURN_SHARED_SECRET must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"

CONF_OUT=/tmp/turnserver.conf

envsubst '${TURN_SHARED_SECRET} ${TURN_REALM}' \
  < /etc/coturn/turnserver.conf.tmpl \
  > "${CONF_OUT}"

exec turnserver -c "${CONF_OUT}" "$@"
