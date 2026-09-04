# Build context is the REPO ROOT: dashboard/src imports packages/react/src
# directly (dogfooding - see InboxPreview.tsx). Builder is glibc
# (bookworm-slim), not alpine: tailwind oxide / lightningcss / esbuild all
# ship arm64-gnu prebuilds as the well-trodden path; the stage is discarded.
FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm ci --no-audit --no-fund
COPY packages ./packages
COPY dashboard ./dashboard
RUN cd dashboard && npm run build

FROM caddy:2-alpine
COPY --from=build /repo/dashboard/dist /srv
COPY deploy/compose/Caddyfile /etc/caddy/Caddyfile
