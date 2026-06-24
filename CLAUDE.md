# Kalshi Daily Temperature Resolution Intelligence Platform

## What this is

A platform to detect when **publicly available weather information is not yet reflected in
Kalshi daily-temperature market prices**. The edge being tested is *latency / mispricing*,
**not** forecasting weather better than professional agencies.

This is built **phase-by-phase**. **Phase 1 (data collection) is complete and signed off.**
We are now in **Phase 2: resolution intelligence**, built **data-first** — settlement-truth
capture and proxy-vs-official reconciliation, then a read-only latency/mispricing analysis.
**No signals, no trading logic, no execution** until earlier phases are validated.

## Scope (locked in)

- **Kalshi daily-temperature markets ONLY.** Kalshi resolves on the **NWS Climatological Report
  (Daily)** — an official, free, ingestible source.
- **Polymarket is out of scope** and has been removed from the codebase (it resolved on Weather
  Underground, which has no free API). Some historical Polymarket rows may remain in the DB from
  early runs — they are append-only history and are simply ignored.

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

- **Frontend** (deferred): Next.js + TypeScript + Tailwind, dark mode.
- **Backend**: Node.js + TypeScript.
- **Database**: PostgreSQL (append-only temporal schema; Neon in the cloud).
- **Cache**: Redis.
- **Deployment**: Docker / docker-compose locally; 24/7 collection on GitHub Actions.
- Monorepo via **pnpm workspaces**. ORM: **Drizzle**. Validation: **Zod**. Logs: **pino**. Tests: **Vitest**.

## Repository layout

```
packages/shared             config, logger, rate-limited HTTP client, shared zod schemas & types
packages/db                 Drizzle schema (append-only tables), migrations, query helpers
services/collector-kalshi   Kalshi temperature series/markets/orderbooks + NWS-CLI resolution + settlement capture
services/collector-weather  NWS + Open-Meteo: forecasts, forecast revisions, observations
scripts                     backfill (Open-Meteo archive), phase1 report, phase2 reconciliation + latency
docker-compose.yml          postgres + redis + collector services
```

The `markets.venue` column distinguishes exchanges; only `kalshi` is collected now.

## Data sources

- **Kalshi API** (`https://api.elections.kalshi.com/trade-api/v2`, public reads, no auth):
  discover temperature series under category `Climate and Weather` (tag "Daily temperature"),
  then `/markets?series_ticker=`, `/markets/{ticker}`, `/markets/{ticker}/orderbook`. Resolves
  on the **NWS Climatological Report (Daily)** in °F. Finalized markets surface the official
  settlement value directly as `expiration_value`.
- **NWS** (`https://api.weather.gov`, free, requires a `User-Agent` header): forecasts + observations.
- **Open-Meteo** (free, no key): forecast, current obs, historical archive, geocoding.
- **Resolution truth:** Kalshi → NWS CLI. The official value is captured via Kalshi's
  `expiration_value`; NWS/Open-Meteo serve as the forecast/observation proxies whose ability to
  track that value is validated in the Phase-2 reconciliation (~1.4 °C MAE as of the Jun-20 gate).
- **Station pinning:** some cities' resolution station differs from the geocoded centroid (e.g.
  LA resolves on coastal LAX, not downtown). `services/collector-weather/src/station-overrides.ts`
  curates coordinate overrides for these.

## Secrets

All credentials live in `.env` (gitignored). Never hardcode keys or commit secrets. See `.env.example`.
Cloud collection uses GitHub Actions repo secrets. A funded wallet exists but is **irrelevant
until a later phase** — paper trading comes first regardless.

## Communication

Be concise and direct. Surface assumptions and tradeoffs. Be honest about uncertainty. Optimize
for correctness, not agreement.
