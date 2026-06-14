# Phase 1 — Data Collection: End-of-Phase Report

_Per the spec's development rules: findings, risks, assumptions, requirements verification,
and recommended next steps. No signals, paper trading, or execution were built (correctly
out of scope for Phase 1)._

## 1. Findings

**The platform's premise is viable at the data layer, across two exchanges.** All required
public data is reachable for free and parses cleanly. Verified live (2026-06-13/14):

### Polymarket
- Daily-temperature markets are NOT found by paging `/markets` (brute-forcing 1,500 markets
  surfaced only "hottest year" markets). They live under the **weather tag**:
  `GET /events?tag_slug=weather&closed=false` → ~200 weather events, ~160 temperature events
  titled `"Highest temperature in <City> on <Date>?"`, each holding ~11 binary **threshold**
  markets (e.g. `"19°C or below"`). Market detail (`clobTokenIds`, prices) needs a second call
  to `/markets/{id}`; order book via `/book?token_id=`.
- **Resolution source = Wunderground** (airport station, °C). Confirmed across markets:
  550 cite Wunderground, plus NWS/weather.gov for some US/HK markets. Wunderground has **no
  free API**, so we store NWS/Open-Meteo as proxies and record the exact station + URL.

### Kalshi (added per your correction that Polymarket isn't the only/ideal venue)
- Public market-data API needs **no auth**. Daily-temperature markets live under category
  **`Climate and Weather`**, tagged `"Daily temperature"` (series like `KXHIGHNY` = "Highest
  temperature in NYC"). ~63 temperature series; each open event has ~12 threshold markets
  (e.g. `"97° or above"`). Prices via `/markets/{ticker}` (dollar fields), book via
  `/markets/{ticker}/orderbook`.
- **Resolution source = NWS Climatological Report (Daily)**, in °F — e.g. *"highest temperature
  recorded in Central Park, New York … as reported by the National Weather Service's
  Climatological Report (Daily)"*. This is an **official, free, ingestable** resolution source,
  which removes the ground-truth gap that Polymarket's Wunderground dependence creates.

### Weather (serves both venues)
- Open-Meteo geocoding resolves every market city to coordinates (global); its forecast,
  current-temperature, and historical-archive endpoints need no key. NWS adds US forecasts +
  observations and is the resolution source for Kalshi.
- **Forecast revisions come free from append-only storage:** each scheduled fetch writes a new
  `forecasts` row (`fetched_at`), so repeated polling reconstructs the revision history.

## 2. What was built

- Monorepo (pnpm) with `@weather/shared` (config, pino logger, rate-limited+retrying HTTP
  client, zod data-quality predicates) and `@weather/db` (Drizzle **append-only** schema +
  migrations). A `markets.venue` column distinguishes `polymarket` vs `kalshi`.
- **collector-polymarket** — weather-event discovery → per-market detail → metadata upsert +
  append-only price/order-book snapshots; resolution parsing; `/prices-history` backfill.
- **collector-kalshi** — temperature-series discovery → threshold markets → metadata upsert +
  append-only price (live midpoint) / order-book snapshots; NWS-CLI resolution parsing;
  candlestick backfill.
- **collector-weather** — geocode each temperature-market city → Open-Meteo forecast + current
  obs (global) and NWS forecast + latest obs (US); Open-Meteo archive backfill.
- Append-only schema (9 tables). Every run logged to `collection_runs`; every payload validated
  into `data_quality_checks` (price∈[0,1], yes+no≈1, temperature plausibility, no-future
  timestamp, city/station coverage gaps).
- `scripts/phase1-report.ts` (per-venue + per-resolution-source coverage) and
  `scripts/smoke-apis.ts` (DB-free live verification of both venues + weather).

## 3. Verification performed

- **Typecheck:** clean across all 6 workspace projects.
- **Unit tests:** 34 passing (validation predicates, hashing, F→C, book summary, and both
  venues' resolution/city/station/threshold/price parsing against real text).
- **Live API smoke test:** Polymarket (200 events → detail → book → geocode → forecast/obs) and
  Kalshi (63 series → Houston event w/ 12 markets → classify → live price → book) — all succeed.
- **Migration:** generates valid SQL for all 9 tables.

**Not yet run here:** the full DB pipeline (`db:migrate` → collectors writing to Postgres →
`report:phase1`). Docker Desktop is installed but its Linux engine requires **WSL2, which is not
installed** on this machine (needs admin + reboot). DB-touching code is typechecked and the SQL
is generated, but row accumulation across cycles must be confirmed once Postgres is available.

## 4. Risks

- **Polymarket ground-truth gap.** Settles on Wunderground (no free API). Proxied by NWS/
  Open-Meteo; proxy values can differ from the official figure. **Kalshi does not have this
  problem** (NWS CLI), which is a strong argument for weighting Kalshi in later phases.
- **Discovery coupling.** Polymarket relies on the `weather` tag + title pattern; Kalshi on the
  `Climate and Weather` category + "Daily temperature" tag. Both are logged each run (event/
  series counts) so silent shrinkage is visible; keyword classifiers act as backstops.
- **Per-market detail volume.** Polymarket ≈160×11 detail calls/cycle; Kalshi ≈63 series ×
  markets. Rate-limited and on a slow cadence, but worth watching.
- **`/prices-history` coarse** for resolved Polymarket markets (backfill-only); Kalshi
  candlestick shape varies (parsed defensively).
- **Unit differences:** Polymarket °C vs Kalshi °F. Stored as labelled rules text; weather data
  normalised to °C. Phase 2 must convert per venue when comparing to observations.

## 5. Assumptions

- NWS/Open-Meteo are acceptable proxies for Polymarket's Wunderground resolution in Phase 1.
- Kalshi's live book **midpoint** is the best single "implied probability" (preferred over a
  possibly-stale last trade).
- Repeated append-only forecast fetches suffice to reconstruct revision history.

## 6. Requirements verification (spec Phase 1)

| Requirement | Status |
| --- | --- |
| Markets, prices, order books, liquidity, volume | ✅ both venues (append-only snapshots) |
| Historical market changes | ✅ append-only snapshots + price-history/candlestick backfill |
| Resolution rules / station / source | ✅ parsed + stored (`resolution_*`, `threshold`, `venue`) |
| Market ID, location, resolution date, contract, YES/NO, volume, timestamp | ✅ in schema |
| Weather: NOAA/NWS/Open-Meteo | ✅ NWS + Open-Meteo (NOAA CDO token optional) |
| Forecasts + revisions, hourly/daily obs, daily max, historical | ✅ append-only forecasts + obs + archive backfill |
| Store every update / never overwrite | ✅ insert-only snapshot/forecast/observation tables |
| Complete historical database | ⚠️ schema + collectors ready; needs Postgres to accumulate (§3) |

## 7. Recommended next steps

1. **Install WSL2** (`wsl --install`, admin + reboot) so Docker's Postgres can run — or point
   `DATABASE_URL` at any Postgres. Then `pnpm db:migrate`, run all three collectors a few
   cycles, and confirm `pnpm report:phase1` shows snapshots, forecast revisions, and
   observations accumulating with passing quality checks.
2. **Phase 2 (resolution intelligence)** — lean on **Kalshi + NWS CLI** first, since its
   resolution source is free and ingestable: current daily max vs threshold, time-to-resolution,
   probability from observations. Decide Polymarket's Wunderground strategy separately (licensed
   API / permitted scraping / accept proxy with documented error bound).

_Reminder: per the spec, do not build signals, paper trading, or execution until the data layer
is validated against accumulated history._
