# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orchestrador/web..." --config.store-dir=/pnpm/store
RUN pnpm --filter @orchestrador/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY devops/config/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
