# The Rivulet sync server: one process, one directory of SQLite files.
#
#   docker build -t rivulet-server .
#   docker run -p 8787:8787 -v rivulet-data:/data rivulet-server
#
# With accounts, the notebook app and the admin console (see render.yaml):
#
#   docker run -p 8787:8787 -v rivulet-data:/data \
#     -e RIVULET_FLAGS="--demo --accounts" -e RIVULET_ADMIN_PASSWORD=... rivulet-server
#
# Put TLS in front of it (a reverse proxy or your platform's https). Phones
# and browsers should reach it over https.
FROM node:22.12.0-alpine

WORKDIR /app
# No dependencies to install: the engine and server use only Node built-ins.
COPY package.json ./
COPY src ./src
COPY apps/cli ./apps/cli
COPY apps/demo-web ./apps/demo-web

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/v1/health >/dev/null || exit 1

ENTRYPOINT ["node", "--experimental-sqlite", "apps/cli/serve.js", "--host", "0.0.0.0", "--port", "8787", "--data", "/data"]
# Rivulet Sync on Android hosts rooms for any app, each with its own schema,
# so the server accepts any. Add --room-tokens (with RIVULET_SECRET set) to
# require per-room access tokens.
CMD ["--open-schema"]
