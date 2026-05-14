# syntax=docker/dockerfile:1.7

FROM node:22.22.2-alpine3.23 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci --ignore-scripts` keeps untrusted postinstalls out of the
# build, but better-sqlite3 ships its native binding via a postinstall
# (`prebuild-install`). Rebuild it explicitly after the install. The
# build-deps (python3, make, g++) are needed only when prebuild-install
# can't find a prebuilt binary for the current node/abi — kept as a
# virtual package so they're removed before the layer is finalised.
RUN npm ci --ignore-scripts \
    && apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm rebuild better-sqlite3 \
    && apk del .build-deps

FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.2-alpine3.23 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
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
