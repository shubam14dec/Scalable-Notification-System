# One image, three roles — the command decides what a container runs:
#   api:    npx tsx src/api/server.ts
#   worker: npx tsx src/workers/index.ts
#   ws:     npx tsx src/ws/gateway.ts
# (the Helm chart sets the command per Deployment)
# node 24, matching the dev machines (dev/prod parity): on node:20 the
# transitive undici build crashed every entrypoint at require time with
# "webidl.util.markAsUncloneable is not a function" (API added in newer
# Node) — found on the first real boot of this image, on the prod box.
FROM node:24-alpine

# Runtime user is `node` (uid 1000, shipped by the base image) — never root.
# Every service port is >1024, so nothing here needs a privileged bind, and
# docker-compose.prod.yml pairs this with cap_drop:[ALL] + no-new-privileges.
# --chown on each COPY is deliberate: a post-hoc `RUN chown -R /app` would
# rewrite every file into a second copy-on-write layer and roughly double the
# image size for zero benefit.
WORKDIR /app
ENV NODE_ENV=production
RUN chown node:node /app

COPY --chown=node:node package.json package-lock.json ./
# The root lockfile links the workspaces; npm ci validates they exist.
COPY --chown=node:node packages ./packages
# npm ci runs as `node` so node_modules is owned by the runtime user (npm
# would otherwise drop root-owned trees the app can never write to).
USER node
# tsx is a devDependency and every entrypoint runs through it; ENV
# NODE_ENV=production above would otherwise make npm omit it.
RUN npm ci --include=dev --no-audit --no-fund

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

EXPOSE 3000 3001 3002
CMD ["npx", "tsx", "src/api/server.ts"]
