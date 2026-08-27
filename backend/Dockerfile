# syntax=docker/dockerfile:1.7

FROM node:22.22.2-alpine3.23 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci --ignore-scripts` keeps untrusted postinstalls out of the
# build, but better-sqlite3 needs its native binding materialised.
# Since v13 (N-API) prebuilts ship INSIDE the npm package — the explicit
# rebuild covers the case where none matches this Alpine/musl runtime
# and falls back to a node-gyp source build. The build-deps (python3,
# make, g++) exist only for that fallback — kept as a virtual package
# so they're removed before the layer is finalised.
RUN npm ci --ignore-scripts \
    && apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm rebuild better-sqlite3 \
    && apk del .build-deps

FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# DB-IP IP-to-Country Lite (CC-BY-4.0). Default "auto" tries the current
# month and walks back up to 3 months — upstream hosts only recent months,
# and a fixed month pin hard-blocked every build (incl. hotfix deploys)
# once it rolled off (2026-08 incident). Pass --build-arg DBIP_MONTH=YYYY-MM
# for a reproducible pinned build; a pinned month that 404s fails loudly.
FROM alpine:3.23 AS geoip
ARG DBIP_MONTH=auto
WORKDIR /geoip
RUN set -eu; \
    if [ "${DBIP_MONTH}" = "auto" ]; then \
      y=$(date -u +%Y); m=$(date -u +%m); tries=4; \
    else \
      y=${DBIP_MONTH%-*}; m=${DBIP_MONTH#*-}; tries=1; \
    fi; \
    m=${m#0}; found=""; \
    while [ "${tries}" -gt 0 ]; do \
      month=$(printf '%s-%02d' "${y}" "${m}"); \
      url="https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz"; \
      echo "geoip: trying ${url}"; \
      rm -f dbip.mmdb.gz; \
      if wget -qO dbip.mmdb.gz "${url}" && [ -s dbip.mmdb.gz ]; then found="${month}"; break; fi; \
      m=$((m - 1)); if [ "${m}" -eq 0 ]; then m=12; y=$((y - 1)); fi; \
      tries=$((tries - 1)); \
    done; \
    if [ -z "${found}" ]; then \
      echo "geoip: ERROR — no dbip-country-lite database downloadable (DBIP_MONTH=${DBIP_MONTH})." >&2; \
      echo "geoip: check https://db-ip.com/db/download/ip-to-country-lite or pass --build-arg DBIP_MONTH=YYYY-MM." >&2; \
      exit 1; \
    fi; \
    gunzip dbip.mmdb.gz \
    && test -s dbip.mmdb \
    && echo "geoip: using dbip-country-lite ${found}"

FROM node:22.22.2-alpine3.23 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=geoip /geoip/dbip.mmdb /app/data/dbip-country-lite.mmdb
ENV GEOIP_DB_PATH=/app/data/dbip-country-lite.mmdb
COPY migrations ./migrations
COPY package.json ./
# Pre-create the DB dir with `app` ownership so the persisted Docker
# volume mounted at /var/lib/auffi inherits the right permissions on
# first boot (Docker preserves the target path's ownership when the
# new volume is empty). Without this the container starts as `app`
# but can't write the SQLite file because the bare volume mount-point
# is owned by root.
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /var/lib/auffi \
    && chown -R app:app /app /var/lib/auffi
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
