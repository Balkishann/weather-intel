# Single image used by migrate + the Kalshi and weather collector services.
FROM node:20-alpine

RUN corepack enable

WORKDIR /app

# Manifests first for layer caching
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/collector-kalshi/package.json services/collector-kalshi/
COPY services/collector-weather/package.json services/collector-weather/

RUN pnpm install --frozen-lockfile || pnpm install

# Source
COPY . .

# Services run via tsx (no build step needed). docker-compose overrides this per service.
CMD ["pnpm", "collect:kalshi"]
