# syntax=docker/dockerfile:1
#
# glogg in one container: the web app, the API and the deep index.
# Settings, keys and the deep index live in /data; mount a volume there.
# Run it with docker-compose.yml (this machine) or docker-compose.coolify.yml (a server).

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# ── Build the web client, then keep only production dependencies ────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Prefer IPv4: on networks without working IPv6, npm otherwise waits out every IPv6 attempt.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY package.json package-lock.json ./
# Patient on slow or flaky networks; the cache mount keeps what earlier attempts downloaded.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000 --maxsockets=6
COPY . .
RUN npm run build:client && npm prune --omit=dev --no-audit --no-fund

# ── Runtime: the server, the built client and production dependencies ───
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    GLOGG_IN_CONTAINER=1 \
    UV_THREADPOOL_SIZE=32 \
    GLOGG_HOME=/data \
    GLOGG_DOWNLOADS_DIR=/data/downloads \
    GLOGG_CONTAINER_RUNTIME=none
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY src/core ./src/core
COPY plugins ./plugins
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "server/index.ts"]
