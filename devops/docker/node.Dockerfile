# syntax=docker/dockerfile:1.7
# One image recipe for every Node service (api, worker, mock-systems...). Build with --build-arg APP=api.
# glibc image on purpose: the Temporal SDK core bridge has no musl (Alpine) build.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update && apt-get install -y --no-install-recommends tini wget ca-certificates \
 && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orchestrador/${APP}..." --config.store-dir=/pnpm/store

FROM base AS runtime
ARG APP
ARG ENTRY=src/index.ts
ARG GIT_SHA=unknown
ENV NODE_ENV=production APP_NAME=${APP} APP_ENTRY=${ENTRY} GIT_SHA=${GIT_SHA}
COPY --from=build --chown=node:node /repo /repo
COPY devops/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
WORKDIR /repo/apps/${APP}
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
