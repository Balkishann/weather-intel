# Single image used by migrate + both collector services.
FROM node:20-alpine

RUN corepack enable

WORKDIR /app

# Manifests first for layer caching
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/collector-polymarket/package.json services/collector-polymarket/
COPY services/collector-kalshi/package.json services/collector-kalshi/
COPY services/collector-weather/package.json services/collector-weather/

RUN pnpm install --frozen-lockfile || pnpm install

# Source
COPY . .

# Services run via tsx (no build step needed for Phase 1)
CMD ["pnpm", "collect:polymarket"]
