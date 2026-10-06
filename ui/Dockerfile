# DAVINCI DKG Council web app: multi-stage build of the Vite static bundle. Build from the
# repository root (the app links the SDK workspace package):
#
#   docker build -f ui/Dockerfile -t ghcr.io/vocdoni/davinci-dkg-council-ui .
#   docker run --rm -p 8080:80 ghcr.io/vocdoni/davinci-dkg-council-ui
#
# The runtime config (/config.json) is baked in at build time by scripts/render-ui-config.sh:
# UI_CONFIG picks the committed starting file (ui/public/config.json, the local dev stack, by
# default) and every other build arg that is set replaces one key. A deployment builds its own
# image, for example:
#
#   docker build -f ui/Dockerfile --build-arg UI_CONFIG=ui/public/config.sepolia.json \
#     --build-arg MANAGER_ADDRESS=0x… --build-arg DEPLOYMENT_BLOCK=… \
#     --build-arg RELAYER_URL=https://… --build-arg ARTIFACTS_BASE_URL=https://… .
#
# The final stage is nginx serving the bundle with a single-page-app fallback (/c/<id>, /new);
# static hosts that build from source (DigitalOcean App Platform, ui/.do/) read the files out of
# /usr/share/nginx/html instead and never run nginx.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json sdk/
COPY ui/package.json ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @vocdoni/davinci-dkg-council-ui...
COPY sdk sdk
COPY ui ui
COPY scripts/render-ui-config.sh scripts/

ARG UI_CONFIG=ui/public/config.json
ARG CHAIN_ID=
ARG MANAGER_ADDRESS=
ARG RPC_URLS=
ARG RELAYER_URL=
ARG ARTIFACTS_BASE_URL=
ARG DEPLOYMENT_BLOCK=
ARG DEV_MODE=

RUN UI_CONFIG=${UI_CONFIG} CHAIN_ID=${CHAIN_ID} MANAGER_ADDRESS=${MANAGER_ADDRESS} RPC_URLS=${RPC_URLS} \
    RELAYER_URL=${RELAYER_URL} ARTIFACTS_BASE_URL=${ARTIFACTS_BASE_URL} \
    DEPLOYMENT_BLOCK=${DEPLOYMENT_BLOCK} DEV_MODE=${DEV_MODE} \
    bash scripts/render-ui-config.sh ui/public/config.json \
 && pnpm --filter @vocdoni/davinci-dkg-council-ui run build

FROM nginx:alpine AS static
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/ui/dist/ /usr/share/nginx/html/
