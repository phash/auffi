#!/usr/bin/env bash
# ops/tests/caddyfile-headers.test.sh — the standalone caddy/Caddyfile is the
# reference for the security headers the cluster block must match. A
# self-host ships exactly this file, so the set must not drift below prod.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

CADDYFILE="${OPS_DIR}/../caddy/Caddyfile"
# Only the header {} block of the auffi.app site — the CSP line is owned by
# `npm run csp:sync` and deliberately not inspected here.
HEADERS="$(awk '/^auffi\.app \{/{site=1} site && /^    header \{/{blk=1; next} blk && /^    \}/{exit} blk' "${CADDYFILE}")"

assert_contains "${HEADERS}" '>Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"' "HSTS: 2 years, includeSubDomains, preload (matches prod)"
assert_contains "${HEADERS}" '>X-Frame-Options "DENY"' "X-Frame-Options DENY"
assert_contains "${HEADERS}" '>X-Content-Type-Options "nosniff"' "nosniff"
assert_contains "${HEADERS}" '>X-XSS-Protection "0"' "legacy XSS auditor explicitly off"
assert_contains "${HEADERS}" '>Referrer-Policy "no-referrer"' "Referrer-Policy no-referrer"
assert_contains "${HEADERS}" '>Permissions-Policy "geolocation=(), microphone=(), camera=()"' "Permissions-Policy denies geolocation/microphone/camera"
assert_contains "${HEADERS}" 'Content-Security-Policy "' "CSP present"

finish
