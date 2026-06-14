# Progress — Daily Temperature Resolution Intelligence Platform

_Last updated: 2026-06-15 (session 4 — **first real reconciliation ✅**, token revoked, latency design note written; gate = Jun-20 re-run)_

## Summary (where we are · accomplished · current state · next steps)

### Where we are
- **Phase 1 (data collection): complete and user-signed-off.** **Phase 2 (resolution
  intelligence): started**, data-first. **No signals, trading, or execution** — and none until
  the data foundation is validated.
- **Scope: Kalshi daily-temperature markets only.** Polymarket is out of scope / parked. See
  [[scope-kalshi-only]].

### What we've accomplished
- **Append-only pipeline on Neon Postgres** collecting Kalshi markets / prices / order books +
  NWS & Open-Meteo forecasts / observations. Data-quality checks all 100%; nothing overwritten.
- **Phase 2 Step 1c — FIRST REAL RECONCILIATION (2026-06-15):** overlap finally arrived — **19
  settled city-days** now have proxy coverage. **Proxies track the official NWS-CLI settlement
  value well: observed-max MAE 1.0 °C, forecast-high MAE 1.3 °C.** This validates the core
  Phase-1 assumption (NWS/Open-Meteo proxy the official resolution value) on real overlapping
  data — no longer just an assumption. One clear outlier: **Los Angeles** (official 22.2 °C vs
  obs-max 28.5 / fc 27.8, Δ +6.3 °C) — a station-mismatch signature (coastal/downtown official
  station vs a hotter inland proxy point), not random noise. All other cities within ~2 °C.
- **Phase 2 Step 1a — settlement truth captured:** new `market_resolutions` table +
  `collectResolutions()`. **17,094 settled markets** recorded with their official settlement
  temperature (Kalshi's `expiration_value`, °F) and yes/no result (16,688 valued).
- **Phase 2 Step 1c — reconciliation report** (`report:phase2`) built & verified: compares each
  settled daily-high official value vs our observed-max / forecast-high proxies.
- **Reliability hardening:** DB retry on all writes, chunked DQ inserts (65k bind-param fix),
  and a price-loop fix (poll only the 564 OPEN markets, not the 17k settled ones).
- **24/7 cloud collection LIVE on GitHub Actions** — laptop-independent. First cloud run verified
  green (2.1-min cycle; wrote 276 markets / 564 prices / 240 resolutions to Neon). Repo
  `github.com/Balkishann/weather-intel`. See [[cloud-collection-github-actions]].
- **Latency-analysis design note written** (`docs/LATENCY_ANALYSIS_DESIGN.md`) — the full plan
  (definitions, table joins, methodology, gate, caveats) for the next build step, so we execute
  fast once the gate passes. Planning only — no code, no execution.
- **Leaked GH_TOKEN fully handled:** removed from `.env` **and revoked on GitHub** (user deleted
  the classic token, 2026-06-15). Cloud collection unaffected (uses repo Actions secrets).

### Current state
- **Collection runs automatically in the cloud**: `collect-kalshi` every 15 min,
  `collect-weather` hourly — data flowing to Neon without the laptop. Local Windows tasks are now
  a redundant backup (safe to disable).
- **Reconciliation now has real overlap (2026-06-15):** 1,339 settled high city-days, **19 with
  proxy coverage** (all Jun 12). The 0-overlap window from session 3 is closed; the series will
  keep densifying as each day's highs settle and observations accumulate.
- **Waiting on the Jun-20 gate:** n=19 (one day) is too thin to build the latency analysis on.
  The cloud is accumulating exactly the data the gate needs; nothing to build until it's checked.
- One cosmetic leftover: a stale `prices running (0)` audit row from the cancelled first cloud run.

### Next steps
1. **✅ DONE (2026-06-15):** first reconciliation run (proxies track official ~1 °C MAE);
   `GH_TOKEN` removed from `.env` and revoked on GitHub; latency-analysis design note written.
2. **⏳ THE GATE — re-run `report:phase2` ~Jun 20** (user will run it locally). Confirm proxy
   MAE still holds ~1–1.5 °C on a larger sample (target ~100+ covered city-days). This is the
   green light for the latency analysis. If MAE jumps, investigate before building anything.
3. **Then — build the latency / mispricing analysis** per `docs/LATENCY_ANALYSIS_DESIGN.md`:
   align `p_mkt(t)` (price snapshots) against `p_info(t)` (forecast revisions + intraday obs),
   measure latency `Δt` and mispricing vs spread+fees. **Read-only; still no execution.**
4. **Let the series densify** (cloud is running); keep `collectResolutions` capturing settlements.
5. _(Lower priority)_ Investigate the **Los Angeles** +6.3 °C station mismatch (coastal cities
   may need station-pinned coords); NWS-CLI direct ingestion as a cross-check; geocoding
   refinement (121 unresolved locations); mark stale `running` audit rows.

## What we're building

A **Phase 1 data-collection platform** that builds a complete, append-only historical
database of daily-temperature prediction markets and the weather data that resolves them.
The edge being tested (in later phases) is **latency / mispricing** — detecting when public
weather info is not yet reflected in market prices — **not** forecasting weather better.

**Decision (locked in):** the product is built around **Kalshi**, not Polymarket.
- Kalshi resolves on the **NWS Climatological Report (Daily)** — official, free, ingestible.
- Polymarket resolves on **Weather Underground** (no free API) → collector **parked**.
  ~1,176 Polymarket markets remain in the DB from earlier runs (historical, append-only).

**Scope (reaffirmed by user 2026-06-14):** Kalshi weather (daily-temperature) markets **only**.
Polymarket is out of scope — do not run/extend its collector. See [[scope-kalshi-only]].

## Phase 2 — resolution intelligence (STARTED 2026-06-14, data-first)

Phase 1 was **signed off by the user**. Phase 2 began with the data foundation only — **no
signals, no trading logic, no execution** yet.

**Step 1a — Kalshi settlement capture (DONE & validated).** New append-only `market_resolutions`
table + `collectResolutions()`. Kalshi finalized markets surface the official settlement value
directly as `expiration_value` (°F — the NWS-CLI high Kalshi resolved on), plus `result`
(yes/no) and `settlement_ts`. Idempotent on `(market_id, source)` — re-runs add only new
settlements. **Captured 17,094 settled temperature markets** (16,688 with a settlement value;
result no=13,989 / yes=3,095 / scalar=10). Wired into `run once` + an hourly cron.

**Step 1c — reconciliation report (BUILT & verified; awaiting overlap).** `report:phase2`
(`scripts/phase2-reconciliation.ts`, read-only) compares each settled daily-high (`KXHIGH*`)
official value against our observed daily max + last forecast high, per city-day.

> **Key finding (2026-06-15, UPDATED):** overlap arrived — **19 settled city-days** now carry
> proxy coverage, and the proxies **track the official NWS-CLI value within ~1 °C**: observed-max
> MAE **1.0 °C**, forecast-high MAE **1.3 °C** (n=19, all Jun 12). This is the first evidence
> (not assumption) that NWS/Open-Meteo proxy the official resolution value. **Outlier: Los Angeles**
> Δ +6.3 °C — a station-mismatch signature (official coastal/downtown station vs hotter inland
> proxy), flagged for geocoding follow-up. The earlier 0-overlap state was a ~1-day timing gap
> (settled days reached Jun 12; proxies started ~Jun 12–13), now closed.
>
> **This concretely proves why the schedule must run unattended:** every day the collector is
> down is a day of **forecast data that can never be backfilled** (you cannot forecast a past
> day), permanently punching a hole in the latency dataset. The overnight-sleep gap is now a
> Phase-2 blocker, not just a nicety.

**Step 1b — NWS-CLI ingestion (deferred):** Kalshi already gives the official value via
`expiration_value`, so direct CLI scraping drops to a *cross-check*, lower priority than
accumulating forward proxy data.

## What we've accomplished

- **Data collection is LIVE.** Both collectors run end-to-end against Neon Postgres and
  populate the append-only schema. Validated with two clean manual cycles + a report.
- **Append-only proven.** Across cycles: market/orderbook snapshots +564 each, forecasts
  +791, observations +106, markets +0 (identity upsert). Nothing overwritten; each cycle
  logs a `collection_runs` row + `data_quality_checks`.
- **Data quality green.** All plausibility/price checks 100% (`forecast_high_plausible`,
  `obs_*`, `yes_no_sum`, `yes_price_range`). Coverage gaps surfaced honestly (not as fake 0%).
- **Made it fast & resilient.** A full Kalshi cycle went from **>20 min (crashing) → ~5 min**;
  discovery alone **~4 min → 45 s**. See "Code changes" below.
- **Scheduling set up** via Windows Task Scheduler (durable cron equivalent).

### Dataset (live — accumulating via the scheduler)

| Table | 2 manual cycles | Latest (2026-06-14, post-cloud) | Notes |
|---|---|---|---|
| markets (Kalshi temp) | 564 | ~17,658 | dimension; **564 open + 17,094 settled** (settled upserted for FK) |
| market_snapshots | 2,523 | 9,115 | Kalshi only (Polymarket parked); price loop polls the 564 OPEN markets |
| orderbook_snapshots | 2,523 | ~9,100 | |
| forecasts | 1,582 | 3,955 | NWS 1,295 + Open-Meteo 2,660; up to 10 revisions/target |
| observations | 219 | 461 | Open-Meteo (global) + NWS (US) |
| market_resolutions | — | 17,094 | **Phase 2** — settled outcomes + official °F value (16,688 valued) |

_Counts now grow continuously via the cloud Actions schedule. Re-run `report:phase1` /
`report:phase2` for live totals. Note: only the **564 open** markets get price snapshots;
settled markets live in the dimension + `market_resolutions` only._

## Code changes — session 3 (2026-06-14, Phase 2 start)

- **`packages/db/src/schema.ts`** — new append-only `market_resolutions` table (unique
  `(market_id, source)`); migration `0001_careful_sabretooth.sql` generated + applied.
- **`packages/db/src/repo.ts`** — `insertMarketResolutions` (idempotent `onConflictDoNothing`),
  `resolvedMarketIds`. **Bug fix:** `recordChecks` now **chunked** (500/insert) — a single
  insert of 16,688 checks exceeded Postgres's 65,535 bind-param limit (surfaced as the
  misleading "bind message has N parameter formats but 0 parameters"). The 17,094 resolutions
  had already committed before that line, so no data was lost.
- **`services/collector-kalshi/src/kalshi.ts`** — settlement fields on the schema
  (`result`, `expiration_value`, `settlement_ts`, strikes); `listSettledMarkets` +
  generalized `listMarketsByStatus`.
- **`services/collector-kalshi/src/temperature.ts`** — `isSettled`, `parseSettlement`, `fToC`
  (+ 4 unit tests; 11/11 pass).
- **`services/collector-kalshi/src/collect.ts`** + **`index.ts`** — `collectResolutions()`
  wired into `run once` and an hourly cron; **`packages/shared/src/config.ts`** — `resolutions`
  cron (default `30 * * * *`, env `CRON_RESOLUTIONS`).
- **`scripts/phase2-reconciliation.ts`** (new) + `report:phase2` — read-only proxy-vs-official
  reconciliation.
- **Regression fix — price loop.** `collectResolutions` upserts every settled market into the
  `markets` dimension (FK), which ballooned `temperatureMarkets()` from ~564 open markets to
  **17,658**, so `collectPrices` tried to fetch order books for ~17k dead markets and blew the
  CI 20-min timeout. Added `repo.pricableKalshiMarkets()` (kalshi temp markets with NO recorded
  resolution) and switched `collectPrices` to it. Found via the first GitHub Actions run.

## Code changes — session 2 (2026-06-14)

- **`packages/db/src/repo.ts`** — wrapped the three remaining un-retried audit writes
  (`startRun`, `finishRun`, `recordChecks`) in **`withRetry`**. These were the only DB writes
  not already covered. `finishRun`/`recordChecks` run *after* the weather cycle's ~9-min
  HTTP-only forecast phase — the exact moment Neon is most likely to have dropped the idle
  pooled connection. A transient drop there previously threw unhandled → `process.exit(1)`,
  which also orphaned the `collection_runs` row in `running` state (one such stale
  `kalshi prices running (0)` row from the killed 03:34 scheduled run is visible in the report).

### Investigation: scheduled **weather** run was failing (`LastTaskResult: 1`)

- Symptom: `WeatherIntel-Weather` died right after "running one weather collection cycle"
  (no forecasts, no `=== exit ===` line), leaving a garbled UTF-16 log fragment.
- **Manual `run once` succeeded** (exit 0, 791 forecasts + 113 obs, ~12 min) — so the
  collector is healthy; the failure was an intermittent transient on the long-idle path.
- **Validated the scheduled path directly** by invoking `scheduled-collect.ps1 -Collector
  weather`: **exit 0**, 791 forecasts + 113 observations, **clean UTF-8 log** — confirming the
  current wrapper produces clean logs and the cycle completes end-to-end. The garbled UTF-16
  lines in `weather.log` are a relic of the old killed run, not the current wrapper.
- The `withRetry` hardening above closes the last unguarded "Connection terminated" window so
  a future idle drop at finish can't kill the run or orphan an audit row. (Honest caveat: the
  original failure was intermittent — not deterministically reproduced — so this is defensive
  hardening of the documented connection-drop class, validated by a clean scheduled cycle.)

## Code changes — session 1

- **`packages/db/src/client.ts`** — pool `on("error")` handler + `keepAlive: true` so Neon
  dropping an idle pooled connection no longer crashes the process.
- **`packages/db/src/repo.ts`** — batched `upsertMarkets` / `insertMarketSnapshots` /
  `insertOrderbookSnapshots` (chunks of 200); **`withRetry`** wrapper that retries DB writes
  on transient connection drops ("Connection terminated", ECONNRESET) — the dead client is
  evicted, the retry gets a fresh connection.
- **`services/collector-kalshi/src/collect.ts`** — price loop restructured to fetch-all-HTTP
  → batch-insert; each market wrapped so one failure can't abort the cycle; discovery
  bulk-upserts; **temperature-only** (non-temp markets skipped).
- **`services/collector-kalshi/src/index.ts`** — HTTP rate raised (`minIntervalMs` 250→120).
- **`scripts/phase1-report.ts`** — venue-segmented snapshots; gap-only checks shown as
  distinct-subject counts instead of a misleading 0% pass-rate.
- **`scripts/scheduled-collect.ps1`** (new) — Task Scheduler wrapper; `run once` per trigger,
  logs UTF-8 to `logs/<collector>.log`.

## Current state

- **Cloud collection (PRIMARY): LIVE on GitHub Actions ✅** — runs 24/7 independent of the
  laptop. See the Cloud deployment section below. This is now the main collection path.
- **Manual on-demand collection: fully working and validated.**
- **Local Windows scheduled collection: set up, fixed, VALIDATED ✅ — now a redundant backup**
  (superseded by the cloud; safe to disable).
  - Tasks: `WeatherIntel-Kalshi` (every 15 min), `WeatherIntel-Weather` (every 60 min),
    both `State=Ready`, overlap-protected (`MultipleInstances IgnoreNew`). Cron is live and
    self-sustaining (auto next-run scheduled).
  - Two bugs found & fixed in the scheduled path:
    1. Wrapper used `$ErrorActionPreference='Stop'`, so the collector's startup Node SSL
       **stderr warning** was treated as terminating → run died instantly. **Fixed** (merge
       `2>&1` to UTF-8 log, no `Stop`).
    2. The fetch-then-flush design leaves DB connections **idle ~5 min** during the HTTP
       phase, so Neon drops them and the final batch flush failed with "Connection
       terminated unexpectedly". **Fixed** via the `withRetry` wrapper (above).
  - **Confirmed by a clean scheduled run**: `=== exit 0 kalshi ===`, task `LastResult=0x0`,
    588 price snapshots / 0 failed checks, batch flush carried through by the retry.
  - **Session 2:** the **weather** scheduled path is now validated too — `scheduled-collect.ps1
    -Collector weather` → `=== exit 0 weather ===`, 791 forecasts + 113 obs, clean UTF-8 log,
    all DQ checks 100%. Audit-write `withRetry` hardening added so a finish-time idle drop
    can't kill the run. (Caveat: the older `result=1` weather failure was intermittent.)

## Known gaps / risks

- **Geocoding:** 73 distinct locations fail to geocode (mostly station-name strings, not
  clean cities). The 76 that resolve still collect fully. Phase 2 refinement.
- **Stale Polymarket rows** inflate raw market counts; report now flags Kalshi as the anchor.
- **Orphaned audit rows:** runs killed mid-cycle (machine sleep, etc.) leave a
  `collection_runs` row stuck in `running` (e.g. `kalshi prices running (0)` from the 03:34
  killed run). Harmless (next run starts a fresh row) but skews "recent runs"; the `finishRun`
  retry reduces, not eliminates, this. A Phase-2 cleanup could mark stale `running` rows.
- **Unattended scheduling — HARDENED 2026-06-14 (session 3).** Overnight killed runs were
  caused by the machine sleeping mid-run (no battery/idle/time-limit policy — verified). Fixed:
  both tasks now `WakeToRun=True` + `StartWhenAvailable=True` + `StopOnIdleEnd=False`; power
  plan set to **never sleep/hibernate on AC** with **wake timers enabled**. So a locked or
  slept (on-AC) machine no longer drops runs.
  - **Remaining caveat:** `LogonType=Interactive` → tasks still only run while the user is
    **logged on** (lock/sleep is now fine; a full log-off stops them). True 24/7 needs
    `LogonType=Password` (stores the user's password) or S4U, or a deploy target — deferred,
    user-decision. On battery the no-sleep change does not apply (AC only).
- Neon free tier auto-pauses when idle; first query wakes it. `price-history points: 0` is
  expected (we rely on forward snapshots). Docker/WSL unavailable → run via `tsx`/pnpm.

## Cloud deployment — GitHub Actions (LIVE ✅, session 3)

Collection now runs 24/7 on GitHub Actions — the laptop is no longer required. Each tick is one
ephemeral `run once` → writes to Neon → exits (same model as the local scheduler).

- **Repo:** `github.com/Balkishann/weather-intel` (public → unlimited free Actions minutes).
  Owner name kept as-is per user. Set up via the GitHub REST API + a temporary classic PAT.
- **Workflows:** `.github/workflows/collect-kalshi.yml` (*/15 — markets+prices+resolutions),
  `collect-weather.yml` (hourly), `db-migrate.yml` (manual, for applying schema changes).
- **Secrets** (encrypted, set via API): `DATABASE_URL`, `NWS_USER_AGENT`.
- **Verified working:** run #2 succeeded — collector step **2.1 min** — and wrote fresh rows to
  Neon (`kalshi markets ok(276)`, `prices ok(564)`, `resolutions ok(240)`), laptop uninvolved.
  Run #1 had failed at the 20-min timeout → see the price-loop regression fix in Code changes s3.

**Notes / housekeeping:**
- **Revoke the setup PAT** (it was pasted in chat) — GitHub → Settings → Developer settings →
  Tokens (classic) → delete; remove the `GH_TOKEN=` line from `.env`. Everything keeps running.
- The local **Windows tasks are now redundant** — disable to avoid double-collection
  (`Disable-ScheduledTask WeatherIntel-*`). Harmless if left (inserts are idempotent/append-only).
- Scheduled Actions auto-disable after **60 days of repo inactivity**; GitHub cron is best-effort
  (can be delayed/coalesced under load). Pushing needs the user's GitHub auth (no `gh` CLI locally).

## How to run

```
# Local manual runs (the cloud does this automatically now):
npx --yes pnpm@9 --filter @weather/collector-kalshi run once     # markets + prices + resolutions
npx --yes pnpm@9 --filter @weather/collector-weather run once    # forecasts + observations
npx --yes pnpm@9 report:phase1                                   # read-only coverage/quality report
npx --yes pnpm@9 report:phase2                                   # proxy-vs-official reconciliation

# Cloud (primary): GitHub Actions runs collect-kalshi (*/15) + collect-weather (hourly)
#   on github.com/Balkishann/weather-intel — trigger/inspect from the repo's Actions tab.
# Local Windows tasks (now redundant backup): Get-ScheduledTask WeatherIntel-* | Disable-ScheduledTask
```

## Next steps (Phase 2)

1. **✅ Unattended 24/7 collection SOLVED via GitHub Actions** (cloud, laptop-independent — see
   Cloud deployment). Supersedes the local wake-to-run hardening. The latency series now
   densifies continuously. _Action:_ revoke the setup PAT; optionally disable the Windows tasks.
2. **Re-run `report:phase2` after Jun 13+ highs settle** (≈Jun 14–15 AM ET) — the first real
   proxy-vs-official comparison. Confirms (or refutes) the Phase-1 assumption that NWS/Open-Meteo
   track the official NWS-CLI settlement value.
3. **Keep `collectResolutions` running hourly** — back-captures recently settled markets
   idempotently; the resolution-truth table is the spine of all later latency analysis.
4. **Then** (only once proxies are shown to track official values): align price snapshots to
   each market's settlement timeline and measure **price-vs-information latency**. Still no
   execution.
5. _(Lower priority)_ NWS-CLI direct ingestion as a cross-check on `expiration_value`;
   geocoding refinement for the 121 unresolved location strings.

## End-of-Phase-1 review

**Requirements verification**
- ✅ Append-only history — verified counts strictly increase, dimension upserts without
  duplication, nothing overwritten.
- ✅ Both collectors land real data — Kalshi markets/prices/books + weather forecasts/obs.
- ✅ Data quality — all plausibility/price checks 100%; coverage gaps surfaced transparently.
- ✅ Reproducible & transparent — every cycle logs a `collection_runs` row + DQ checks.
- ✅ Unattended reliability — scheduled run confirmed `exit 0`; cron self-sustaining.

**Facts** — the pipeline reliably collects and persists Kalshi temperature markets and their
NWS / Open-Meteo resolution proxies; forecast revisions are being captured.

**Assumptions (unvalidated — Phase 2+)** — that NWS/Open-Meteo proxy the NWS-CLI resolution
value well; that snapshot cadence is dense enough to detect latency; that mispricing exists
at all. **No profitability or predictive power is claimed.**

**Risks** — geocoding gaps reduce city coverage; logged-on-only scheduling; Neon free-tier limits.

**Recommended next step** — let the schedule accumulate data, then get sign-off to start
Phase 2. **Phase 1 is functionally complete and self-running.**
