#!/usr/bin/env bash
# Best-effort IndexNow submission — notifies Bing (and thereby ChatGPT Search,
# which uses Bing's index) of changed/new URLs. Key file must be live at
# https://auffi.app/${KEY}.txt. Safe to run anytime; never fails a pipeline.
set -u
KEY="175972328cee2b184e026d4b88f7429d"
HOST="auffi.app"
URLS=(
  "https://auffi.app/"
  "https://auffi.app/download/"
  "https://auffi.app/vergleich/"
  "https://auffi.app/vergleich/teamviewer/"
  "https://auffi.app/vergleich/anydesk/"
  "https://auffi.app/en/"
  "https://auffi.app/en/download/"
  "https://auffi.app/en/compare/"
  "https://auffi.app/en/compare/teamviewer/"
  "https://auffi.app/en/compare/anydesk/"
  "https://auffi.app/vergleich/teamviewer-kommerzielle-nutzung/"
  "https://auffi.app/en/compare/teamviewer-commercial-use/"
  "https://auffi.app/vergleich/rustdesk/"
  "https://auffi.app/en/compare/rustdesk/"
  "https://auffi.app/vergleich/chrome-remote-desktop/"
  "https://auffi.app/en/compare/chrome-remote-desktop/"
  "https://auffi.app/bildschirm-teilen-ohne-installation/"
  "https://auffi.app/en/screen-sharing-without-install/"
)
body=$(printf '{"host":"%s","key":"%s","keyLocation":"https://%s/%s.txt","urlList":[%s]}' \
  "$HOST" "$KEY" "$HOST" "$KEY" \
  "$(printf '"%s",' "${URLS[@]}" | sed 's/,$//')")
curl -sS -m 15 -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json" -d "$body" \
  -o /dev/null -w "IndexNow → HTTP %{http_code}\n" || echo "IndexNow ping failed (non-fatal)"
