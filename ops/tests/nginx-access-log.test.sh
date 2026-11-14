#!/usr/bin/env bash
# ops/tests/nginx-access-log.test.sh — the viewer/dashboard nginx sidecars must
# not inherit the stock image's `main` access log: it ends in
# $http_x_forwarded_for (Caddy sets it → full client IP per line) and logs
# $request verbatim, so the dashboard's /verify|/reset|/verify-email-change/<token>
# mail links and the viewer's ?code=<session code> landed in `docker logs`.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

NGINX_DIR="${OPS_DIR}/../nginx"

for conf in auffi-viewer.conf auffi-dashboard.conf; do
  file="${NGINX_DIR}/${conf}"
  echo "# ${conf}"
  assert_eq "1" "$(grep -cE '^    access_log /dev/stdout auffi_redacted;$' "${file}")" \
    "${conf}: server-level access_log uses the redacted format"
  fmt="$(awk '/^log_format auffi_redacted/{f=1} f{print} f && /;\s*$/{exit}' "${file}")"
  assert_contains "${fmt}" "log_format auffi_redacted" "${conf}: defines log_format auffi_redacted"
  for banned in '$remote_addr' '$http_x_forwarded_for' '$realip_remote_addr' '$request_uri' '$args' '$query_string' '$http_referer'; do
    assert_not_contains "${fmt}" "${banned}" "${conf}: log_format omits ${banned}"
  done
  assert_eq "" "$(grep -oE '\$request([^_a-z]|$)' <<<"${fmt}" || true)" "${conf}: log_format omits the raw \$request line"
  assert_contains "${fmt}" '$auffi_log_path' "${conf}: log_format logs the sanitised path"
done

echo "# dashboard: mail-token routes are masked"
DASH_MAP="$(awk '/^map \$request_uri \$auffi_log_path/{f=1} f{print} f && /^\}/{exit}' "${NGINX_DIR}/auffi-dashboard.conf")"
assert_contains "${DASH_MAP}" 'verify|reset|verify-email-change' "map covers every token route the mailer links to"
assert_contains "${DASH_MAP}" '[redacted]' "token segment is replaced"

finish
