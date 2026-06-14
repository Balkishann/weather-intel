# Polymarket Daily Temperature Resolution Intelligence Platform

## What this is

A platform to detect when **publicly available weather information is not yet reflected in
Polymarket daily-temperature market prices**. The edge being tested is *latency / mispricing*,
**not** forecasting weather better than professional agencies.

This is built **phase-by-phase**. We are currently building **Phase 1 only: data collection.**
No signals, no trading logic, no execution until earlier phases are validated.

## Non-negotiable principles

- **Data first, validation first.** Never build trading logic before data collection. Never
  build execution before paper trading. Optimize for data quality, speed, validation,
  transparency, and reproducibility — never for profit.
- **Never assume** profitability, predictive power, or market inefficiency. Data drives all conclusions.
- **Append-only history.** Store every update. **Never overwrite historical data.** Snapshot
  tables are insert-only.
- **Evidence over intuition.** Prove with tests/metrics before asserting. Separate facts,
  assumptions, and opinions.
- **Simplicity & surgical changes.** Smallest solution that works; touch only what the task needs.
- At the **end of each phase**: explain findings, risks, assumptions; verify requirements; recommend next steps.

## Tech stack

- **Frontend** (Phase 8, deferred): Next.js + TypeScript + Tailwind, dark mode.
- **Backend**: Node.js + TypeScript.
- **Database**: PostgreSQL (append-only temporal schema).
- **Cache**: Redis.
- **Deployment**: Docker / docker-compose.
- Monorepo via **pnpm workspaces**. ORM: **Drizzle**. Validation: **Zod**. Logs: **pino**. Tests: **Vitest**.

## Repository layout

```
packages/shared              config, logger, rate-limited HTTP client, shared zod schemas & types
packages/db                  Drizzle schema (append-only tables), migrations, query helpers
services/collector-polymarket  Gamma markets + CLOB books/prices/midpoints + resolution parsing
services/collector-kalshi      Kalshi temperature series/markets/orderbooks + NWS-CLI resolution
services/collector-weather     NWS + Open-Meteo: forecasts, forecast revisions, observations
scripts                      backfill (prices-history, Open-Meteo archive), phase1 report, migrate
docker-compose.yml           postgres + redis + collector services
```

Both exchanges run the same daily-temperature markets; the `markets.venue` column
distinguishes them (`polymarket` | `kalshi`). The weather collector serves both.

## Data sources

- **Polymarket Gamma API** (`https://gamma-api.polymarket.com`, public): discover via
  `/events?tag_slug=weather`, fetch detail via `/markets/{id}`. Resolves on **Wunderground**
  (airport station, °C) — Wunderground has no free API, so NWS/Open-Meteo serve as proxies.
- **Polymarket CLOB API** (`https://clob.polymarket.com`, public reads): `/book`, `/price`,
  `/midpoint`, `/prices-history` (coarse for resolved markets — capture our own snapshots).
- **Kalshi API** (`https://api.elections.kalshi.com/trade-api/v2`, public reads, no auth):
  discover temperature series under category `Climate and Weather` (tag "Daily temperature"),
  then `/markets?series_ticker=`, `/markets/{ticker}`, `/markets/{ticker}/orderbook`. Resolves
  on the **NWS Climatological Report (Daily)** in °F — an official, **free** resolution source.
- **NWS** (`https://api.weather.gov`, free, requires a `User-Agent` header).
- **Open-Meteo** (free, no key): forecast, current obs, historical archive, geocoding.
- **Resolution truth:** Kalshi → NWS CLI (free, ingestable). Polymarket → Wunderground (no free
  API; proxied by NWS/Open-Meteo). Resolving Polymarket ground-truth is a Phase 2 decision.

## Secrets

All credentials live in `.env` (gitignored). Never hardcode keys or commit secrets. See `.env.example`.
A funded wallet exists but is **irrelevant until Phase 7** — paper trading comes first regardless.

## Communication

Be concise and direct. Surface assumptions and tradeoffs. Be honest about uncertainty. Optimize
for correctness, not agreement.
