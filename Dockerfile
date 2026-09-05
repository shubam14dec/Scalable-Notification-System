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

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# The root lockfile links the workspaces; npm ci validates they exist.
COPY packages ./packages
# tsx is a devDependency and every entrypoint runs through it; ENV
# NODE_ENV=production above would otherwise make npm omit it.
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000 3001 3002
CMD ["npx", "tsx", "src/api/server.ts"]
