# Design note — Latency / mispricing analysis (Phase 2, NOT YET BUILT)

_Drafted 2026-06-15. **Planning only.** This is the design we execute **after** the Jun-20
reconciliation gate passes (proxy MAE holds ~1–1.5 °C on ~100+ city-days). It is **read-only
analysis** — no signals fed to anything, no trading logic, no execution. Those remain later
phases per CLAUDE.md._

## 1. Objective & hypothesis

**Edge being tested:** *latency / mispricing* — moments when **publicly available weather
information is not yet reflected in Kalshi daily-temperature prices**. We are **not** trying to
forecast weather better than NWS.

**Hypothesis (to confirm or refute with data):** for a settled daily-high market, there exist
windows where public weather info (a forecast revision, or accumulating intraday observations)
already implies the outcome with high confidence, **before** the market price moves to match.
If those windows are real, persistent, and large enough to clear fees/spread, that is the edge.
**We assume none of this.** The analysis may well show prices lead the proxies — that is a valid,
publishable result.

## 2. What we measure (definitions)

- **Market-implied probability** `p_mkt(t)` — the `yes_price` (fallback: `midpoint`) of a
  market at snapshot time `t`. For a "X°F or above" bucket this is the market's P(high ≥ X).
- **Information-implied signal** `p_info(t)` — a probability derived **only from public weather
  data available at or before `t`**:
  - from **forecasts**: most-recent `forecast_high_c` for the target day vs the bucket strike;
  - from **intraday observations**: the running daily max so far vs the strike (once the day's
    observed max already exceeds the strike, P(yes)→1 and can never reverse — a hard signal).
- **Latency** `Δt` — for a given information event (forecast revision crossing a strike, or
  observed-max crossing a strike), the elapsed time until `p_mkt` moves to within a tolerance of
  the new `p_info`. This is the core quantity.
- **Mispricing magnitude** — `|p_mkt(t) − p_info(t)|` during the latency window, and whether it
  exceeds the round-trip cost (spread from `orderbook_snapshots` + Kalshi fees). Reported, not
  acted on.

## 3. Data inputs (existing append-only tables)

| Concept | Table.column | Notes |
|---|---|---|
| Settlement truth | `market_resolutions.settled_value` (°F), `.result`, `.settled_at` | official NWS-CLI high via Kalshi `expiration_value`; target day parsed from ticker `-YYMONDD-` |
| Price over time | `market_snapshots.yes_price` / `.midpoint`, `.captured_at` | only OPEN markets get snapshots → **prices exist only while market is live** (the relevant window) |
| Spread / depth | `orderbook_snapshots.bids/asks`, `.captured_at` | for tradeable-cost realism |
| Strike / bucket | `markets.threshold`, `.raw` (Kalshi strikes), `.location` | parse the °F strike per bucket |
| Forecast info | `forecasts.forecast_high_c`, `.fetched_at`, `.forecast_run_at`, `.target_date` | **`fetched_at` = when info became public to us**; revisions are append-only |
| Observation info | `observations.temp_c`, `.daily_max_temp_c`, `.observed_at` | running intraday max |
| Station↔city | `forecasts(station_id, location)` map | observations carry only `station_id` (same join the reconciliation uses) |

**Timestamp discipline (critical):** the latency measurement is only valid if every
information point is keyed by **when it became knowable** (`forecasts.fetched_at`,
`observations.observed_at`), never by target date. Using `forecast_run_at` vs `fetched_at` is a
deliberate choice to document — we know `fetched_at`; `forecast_run_at` is the model issue time.

## 4. Methodology (step by step)

1. **Universe.** Settled `KXHIGH*` markets where we have (a) ≥1 price snapshot while open and
   (b) weather proxy coverage on the target day. Reuse the reconciliation join.
2. **Parse the strike** per bucket from `markets` (the °F threshold defining "≥ X").
3. **Build `p_info(t)` timeline** per (market, day): merge forecast revisions (by `fetched_at`)
   and the running observed max (by `observed_at`) into a step function of an info-implied
   P(yes). Start simple: a calibrated logistic of `(proxy_high − strike)` using the **MAE from
   reconciliation as the spread** — so the proxy's known error becomes the uncertainty band.
   Once observed-max ≥ strike, snap to ~1 (irreversible); symmetric for the day ending below.
4. **Build `p_mkt(t)` timeline** from `market_snapshots`.
5. **Align & diff.** As-of join the two step functions on time; compute `|p_mkt − p_info|`.
6. **Detect information events & measure latency.** At each forecast revision or observed-max
   strike-crossing, record `Δt` until `p_mkt` converges to the new `p_info` (within tolerance).
7. **Cost overlay.** From `orderbook_snapshots`, attach the prevailing spread; flag windows
   where mispricing > round-trip cost. **Report only.**
8. **Validate against truth.** Cross-check every `p_info→1/0` collapse against the actual
   `market_resolutions.result` — the info signal must agree with how the market really settled.

## 5. Outputs

- A per-(market, day) table: strike, settlement result, max observed mispricing, latency `Δt`,
  whether it cleared cost.
- Aggregate distributions: latency by city, by lead-time-to-settlement, by signal type
  (forecast vs observation).
- An honest verdict: **does** public info lead price, by how much, how often, and does it
  survive spread+fees. A null result ("prices lead / no exploitable gap") is an acceptable and
  expected possible outcome.

## 6. Prerequisites / gate (do not start before these)

1. **Reconciliation MAE holds** (~1–1.5 °C) on a larger sample — the Jun-20 check. If proxies
   don't track official values, `p_info` is untrustworthy and this whole analysis is invalid.
2. **Enough open-market price history** spanning each market's final hours (the snapshot loop
   already covers the 564 open markets every ~15 min).
3. **Strike parsing verified** against a handful of known Kalshi buckets.

## 7. Explicit non-goals (this phase)

- No order placement, no paper trading, no signal service. Read-only `scripts/` analysis,
  same shape as `phase2-reconciliation.ts`.
- No claim of profitability or predictive power until the data shows it.

## 8. Known caveats to carry forward

- **Timezone:** official "day" is local; we bucket observations by UTC date (fine for US
  afternoon highs, approximate elsewhere) — same caveat as the reconciliation.
- **Snapshot cadence (~15 min)** bounds the finest latency we can resolve. Document it.
- **Survivorship:** only OPEN markets get price snapshots, so the dataset is naturally the live
  trading window — good for this purpose, but state it.
- **LA-type station mismatch** inflates `p_info` error for a few coastal cities; exclude or
  station-pin before trusting their latency numbers.
