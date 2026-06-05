FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/central-api/package.json apps/central-api/
COPY packages/rdk-core/package.json packages/rdk-core/

RUN pnpm install --frozen-lockfile

COPY packages/rdk-core/ packages/rdk-core/
COPY apps/central-api/ apps/central-api/

RUN pnpm --filter @rdk/core build
RUN pnpm --filter @rdk/central-api build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

RUN npm install -g pnpm

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/rdk-core/dist/ packages/rdk-core/dist/
COPY --from=builder /app/packages/rdk-core/package.json packages/rdk-core/
COPY --from=builder /app/apps/central-api/dist/ apps/central-api/dist/
COPY --from=builder /app/apps/central-api/package.json apps/central-api/
COPY --from=builder /app/node_modules/ node_modules/

EXPOSE 3000
CMD ["node", "apps/central-api/dist/main.js"]
