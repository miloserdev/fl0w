# syntax=docker/dockerfile:1
# Node Flow Board: Next.js-приложение + раннеры флоу (TypeScript через tsx — исходники пакетов нужны и в рантайме).
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# манифесты отдельно: слой с зависимостями не пересобирается при правке кода
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/schema/package.json packages/schema/
COPY packages/blocks/package.json packages/blocks/
COPY packages/engine/package.json packages/engine/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @fl0w/web build

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    FL0W_DATA_DIR=/data/flows \
    FL0W_MEMORY_DIR=/data/memory \
    FL0W_FILES_DIR=/data/files
# tini: корректные сигналы и уборка процессов-раннеров; bash — для блока Shell (по умолчанию выключен)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates bash \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/flows /data/memory /data/files \
 && chown -R node:node /data /app

COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/web ./apps/web
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/schema/node_modules ./packages/schema/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/blocks/node_modules ./packages/blocks/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next

USER node
WORKDIR /app/apps/web
# флоу, банки памяти и файлы живут вне контейнера: смонтируйте /data (и при желании /data/files отдельно)
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/flows').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
