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
assert_contains "${HEADERS}" '>Permissions-Policy "geolocation=(), microphone=(), camera=(), display-capture=(), usb=(), payment=()"' "Permissions-Policy denies geolocation/microphone/camera/display-capture/usb/payment"
assert_contains "${HEADERS}" '>Cross-Origin-Opener-Policy "same-origin"' "COOP same-origin"
assert_contains "${HEADERS}" 'Content-Security-Policy "' "CSP present"
CSP="$(grep -F 'Content-Security-Policy "' <<<"${HEADERS}")"
for directive in "base-uri 'none';" "form-action 'self';" "object-src 'none';" "frame-ancestors 'none';"; do
  assert_contains "${CSP}" "${directive}" "CSP carries ${directive}"
done

# CORP and the Via strip live outside the header {} block: CORP needs a path
# matcher (og-image.png stays embeddable by link-preview clients), and a
# deletion would defer the whole block.
SITE="$(awk '/^auffi\.app \{/{site=1} site{print} site && /^\}/{exit}' "${CADDYFILE}")"
assert_contains "${SITE}" '@corp_same_origin not path /og-image.png' "CORP matcher exempts og-image.png"
assert_contains "${SITE}" 'header @corp_same_origin >Cross-Origin-Resource-Policy "same-origin"' "CORP same-origin on everything else"
assert_contains "${SITE}" 'header -Via' "Via header stripped"

finish
