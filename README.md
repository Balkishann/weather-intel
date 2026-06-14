# Polymarket Daily Temperature Resolution Intelligence — Phase 1

Automated, **append-only** collection of Polymarket daily-temperature markets and the weather
data that resolves them. The platform's hypothesis: there may be an edge in detecting when
public weather information is **not yet reflected in market prices** — not in forecasting
better. Phase 1 only builds the data foundation. No signals, no trading.

See [CLAUDE.md](CLAUDE.md) for principles and [the plan](.claude/plans) for scope.

## Quick start

```bash
cp .env.example .env          # adjust if needed
pnpm install
docker compose up -d postgres redis
pnpm db:migrate               # create append-only schema
pnpm collect:polymarket       # start Polymarket collector (Ctrl-C to stop)
pnpm collect:kalshi           # start Kalshi collector (separate terminal)
pnpm collect:weather          # start weather collector (separate terminal)
pnpm report:phase1            # coverage + data-quality summary (per venue + source)
```

Or run everything in Docker:

```bash
docker compose up --build
```

## Layout

| Path | Purpose |
| --- | --- |
| `packages/shared` | config, logger, rate-limited HTTP client, shared zod schemas |
| `packages/db` | Drizzle append-only schema, migrations, query helpers |
| `services/collector-polymarket` | Gamma markets + CLOB books/prices/midpoints + resolution parsing |
| `services/collector-kalshi` | Kalshi temperature series/markets/orderbooks + NWS-CLI resolution |
| `services/collector-weather` | NWS + Open-Meteo forecasts, revisions, observations |
| `scripts` | backfill + phase1 coverage report |

## Invariants

- **Never overwrite history.** All `*_snapshots`, `forecasts`, `observations` are insert-only.
- **Validate before trust.** Every payload is zod-checked; quality results land in `data_quality_checks`.
- **Every run is logged** to `collection_runs` for auditability.

## Resolution sources

- **Kalshi** resolves on the **NWS Climatological Report (Daily)** — official, free, ingestable.
- **Polymarket** resolves on **Weather Underground** (airport station), which has no free API;
  Phase 1 stores NWS + Open-Meteo as proxies and records each market's station/source/URL.
  True Wunderground ground-truth ingestion is a Phase 2 decision.
