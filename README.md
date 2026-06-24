# Kalshi Daily Temperature Resolution Intelligence

Automated, **append-only** collection of Kalshi daily-temperature markets and the weather data
that resolves them. The platform's hypothesis: there may be an edge in detecting when public
weather information is **not yet reflected in market prices** — not in forecasting better.
Data foundation first; **no signals, no trading**.

**Scope: Kalshi only.** Polymarket is out of scope and has been removed (it resolved on Weather
Underground, which has no free API).

See [CLAUDE.md](CLAUDE.md) for principles and [progress.md](progress.md) for current state.

## Quick start

```bash
cp .env.example .env          # adjust if needed
pnpm install
docker compose up -d postgres redis
pnpm db:migrate               # create append-only schema
pnpm collect:kalshi           # start Kalshi collector (Ctrl-C to stop)
pnpm collect:weather          # start weather collector (separate terminal)
pnpm report:phase1            # coverage + data-quality summary
pnpm report:phase2            # proxy-vs-official reconciliation
pnpm report:phase2:latency    # price-vs-information latency analysis (read-only)
```

Or run everything in Docker:

```bash
docker compose up --build
```

Cloud collection runs 24/7 on GitHub Actions (laptop-independent).

## Layout

| Path | Purpose |
| --- | --- |
| `packages/shared` | config, logger, rate-limited HTTP client, shared zod schemas |
| `packages/db` | Drizzle append-only schema, migrations, query helpers |
| `services/collector-kalshi` | Kalshi temperature series/markets/orderbooks + NWS-CLI resolution + settlement capture |
| `services/collector-weather` | NWS + Open-Meteo forecasts, revisions, observations |
| `scripts` | backfill + phase1/phase2 reports |

## Invariants

- **Never overwrite history.** All `*_snapshots`, `forecasts`, `observations`, `market_resolutions` are insert-only.
- **Validate before trust.** Every payload is zod-checked; quality results land in `data_quality_checks`.
- **Every run is logged** to `collection_runs` for auditability.

## Resolution source

- **Kalshi** resolves on the **NWS Climatological Report (Daily)** — official, free, ingestible.
  The official settlement value is captured via Kalshi's `expiration_value`; NWS + Open-Meteo
  forecasts/observations are the proxies whose tracking of that value is validated in the
  Phase-2 reconciliation.
