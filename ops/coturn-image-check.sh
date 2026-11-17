#!/usr/bin/env bash
# Check coturn images against the production template and entrypoint before a
# version bump: SSRF deny-list loaded and enforced, no silently ignored
# options, TLS cert hot reload via SIGUSR2.
#
#   ops/coturn-image-check.sh 4.18.0 4.19.0    # old and new side by side
#
# docs/footguns.md asks for exactly this after every coturn image bump:
# "ranges loaded in the log" is not proof, a relay request has to be denied.
# Every version must print the same verdicts as the one running in prod.
# Needs docker and openssl; run it on testbox via tb-run.
set -uo pipefail

[[ $# -ge 1 ]] || { echo "Aufruf: $0 <coturn-version>..." >&2; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=auffi-coturn-image-check
PORT=15349
# Public peers must be relayed; private and IPv4-mapped private peers must
# not (the mapped form is only matched by the v6 ranges).
PEERS=(8.8.8.8 10.0.0.1 192.168.1.1 ::ffff:10.0.0.1 2001:4860:4860::8888)
EXPECT=(ALLOWED DENIED DENIED DENIED ALLOWED)

fail=0
check() {  # <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then printf '  ok    %s: %s\n' "$1" "$2"
  else printf '  FAIL  %s: %s (erwartet %s)\n' "$1" "$2" "$3"; fail=1; fi
}

for v in "$@"; do
  work="$(mktemp -d)"; mkdir -p "$work/certs"
  mkcert() {
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$1" \
      -keyout "$work/k.pem" -out "$work/c.pem" 2>/dev/null
    mv "$work/k.pem" "$work/certs/key.pem"; mv "$work/c.pem" "$work/certs/cert.pem"
    chmod 644 "$work/certs/"*.pem
  }
  served_cn() {
    echo | openssl s_client -connect "127.0.0.1:$PORT" 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
  }
  mkcert certA
  docker rm -f "$NAME" >/dev/null 2>&1
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5349" \
    -v "$REPO/coturn/turnserver.conf.tmpl:/etc/coturn/turnserver.conf.tmpl:ro" \
    -v "$REPO/coturn/entrypoint.sh:/entrypoint.sh:ro" -v "$work/certs:/var/lib/turn" \
    -e TURN_SHARED_SECRET=check-secret -e TURN_REALM=check.local -e TURN_CERT_POLL_SEC=2 \
    --entrypoint /bin/sh "coturn/coturn:${v}-alpine" /entrypoint.sh >/dev/null
  sleep 4

  echo "== coturn $v"
  logs="$(docker logs "$NAME" 2>&1)"
  check "deny-list ranges loaded" "$(grep -c 'Black listing' <<<"$logs")" \
    "$(grep -c '^denied-peer-ip=' "$REPO/coturn/turnserver.conf.tmpl")"
  check "ignored options (Bad configuration format)" "$(grep -ci 'Bad configuration' <<<"$logs")" 0

  for i in "${!PEERS[@]}"; do
    out="$(docker exec "$NAME" timeout 8 turnutils_uclient -W check-secret \
      -e "${PEERS[$i]}" -r 3480 -n 2 -m 1 -l 100 127.0.0.1 2>&1)"
    if grep -qiE '403|forbidden' <<<"$out"; then verdict=DENIED
    elif grep -qiE 'success|start sending|Total' <<<"$out"; then verdict=ALLOWED
    else verdict="UNKLAR: $(tail -1 <<<"$out")"; fi
    check "relay to ${PEERS[$i]}" "$verdict" "${EXPECT[$i]}"
  done

  check "TLS cert before reload" "$(served_cn)" certA
  mkcert certB
  sleep 9
  check "TLS cert after SIGUSR2 reload" "$(served_cn)" certB

  docker rm -f "$NAME" >/dev/null
  rm -rf "$work"
done

(( fail == 0 )) && echo "== alle Prüfungen ok" || { echo "== FEHLER (s. oben)"; exit 1; }
