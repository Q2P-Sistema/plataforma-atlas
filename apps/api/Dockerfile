FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages/core/ packages/core/
COPY packages/auth/ packages/auth/
COPY packages/db/ packages/db/
COPY apps/api/ apps/api/
RUN pnpm --filter @atlas/core build && \
    pnpm --filter @atlas/db build && \
    pnpm --filter @atlas/auth build && \
    pnpm --filter @atlas/api build
# Rewrite main fields to point to compiled dist for production
RUN for pkg in packages/core packages/auth packages/db; do \
      sed -i 's|"main": "./src/index.ts"|"main": "./dist/index.js"|' $pkg/package.json; \
    done

FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json /app/tsconfig.base.json ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/auth/package.json packages/auth/
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/auth/dist packages/auth/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/db/migrations packages/db/migrations
EXPOSE 3005
CMD ["node", "apps/api/dist/server.js"]
