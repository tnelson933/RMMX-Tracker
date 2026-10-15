# RM Tracker cloud API + web build for self-hosting (replaces Replit deployment).
# Build from the repo root:  docker compose -f deploy/docker-compose.yml build
FROM node:24-bookworm-slim AS app

# ffmpeg: announcer text-to-speech audio conversion. python3/make/g++: native
# deps compiled from source during install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app
COPY . .

# Only the cloud API, web app and DB tooling (skips Electron/Expo installs).
RUN pnpm install --frozen-lockfile \
    --filter @workspace/api-server... \
    --filter @workspace/race-platform... \
    --filter @workspace/db...

RUN cd artifacts/api-server && node build.mjs
# Same-origin build: no VITE_CLOUD_URL, so the site talks to /api on its own host.
RUN cd artifacts/race-platform && BASE_PATH=/ NODE_ENV=production pnpm exec vite build --config vite.config.ts

WORKDIR /app/artifacts/api-server
ENV NODE_ENV=production PORT=8080 UPLOADS_DIR=/data/uploads
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

# Static web files served by Caddy.
FROM caddy:2.8-alpine AS web
COPY --from=app /app/artifacts/race-platform/dist/public /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
