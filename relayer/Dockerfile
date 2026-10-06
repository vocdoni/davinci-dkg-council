# DAVINCI DKG Council relayer. Build from the repository root (the relayer needs the SDK
# workspace package):
#
#   docker build -f relayer/Dockerfile -t ghcr.io/vocdoni/davinci-dkg-council-relayer .
#   docker run --rm -p 8080:8080 -v council-relayer:/data -e COUNCIL_RPC_URL=... \
#     -e COUNCIL_MANAGER_ADDRESS=... -e COUNCIL_PRIVATE_KEY=... -e COUNCIL_COMBINER_ENABLED=true \
#     ghcr.io/vocdoni/davinci-dkg-council-relayer
#
# Configuration is env-only; see docs/relayer.md.

FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json sdk/
COPY relayer/package.json relayer/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @vocdoni/davinci-dkg-council-relayer...
COPY sdk sdk
COPY relayer relayer
RUN pnpm --filter @vocdoni/davinci-dkg-council-relayer run build

FROM base AS runtime
ENV NODE_ENV=production COUNCIL_PORT=8080 COUNCIL_DATA_DIR=/data
RUN pnpm install --frozen-lockfile --prod --filter @vocdoni/davinci-dkg-council-relayer... && rm -rf /root/.cache /root/.local/share/pnpm \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/sdk/dist sdk/dist
COPY --from=build /app/relayer/dist relayer/dist
USER node
# Pending signed transactions, outcomes, the spend log and sponsorship counters: keep across restarts.
VOLUME /data
EXPOSE 8080
WORKDIR /app/relayer
CMD ["node", "dist/main.js"]
