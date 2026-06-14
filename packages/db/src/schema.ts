import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * APPEND-ONLY temporal schema. Snapshot/observation/forecast tables are insert-only:
 * nothing is ever UPDATEd or DELETEd. `markets` and `weather_stations` are the only
 * slowly-changing dimension tables (upsert on identity).
 */

// ---- Dimension: markets -------------------------------------------------------------
export const markets = pgTable(
  "markets",
  {
    marketId: text("market_id").primaryKey(), // Polymarket condition id or Kalshi ticker
    venue: text("venue").notNull().default("polymarket"), // "polymarket" | "kalshi"
    slug: text("slug"),
    question: text("question"),
    eventTitle: text("event_title"),
    location: text("location"), // parsed city/region, nullable until mapped
    resolutionDate: timestamp("resolution_date", { withTimezone: true }),
    resolutionStation: text("resolution_station"), // named station, e.g. "Heathrow Airport"
    resolutionSource: text("resolution_source"), // e.g. "weather_underground", "nws"
    resolutionUrl: text("resolution_url"), // wunderground history URL, if present
    resolutionRules: text("resolution_rules"), // full description text
    threshold: text("threshold"), // bucket label, e.g. "19°C or below"
    contractStructure: text("contract_structure"), // "binary" | "scalar" | "categorical"
    isTemperatureMarket: boolean("is_temperature_market").notNull().default(false),
    clobTokenIds: jsonb("clob_token_ids"), // string[] of CLOB token ids
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => [
    index("markets_is_temp_idx").on(t.isTemperatureMarket),
    index("markets_resolution_date_idx").on(t.resolutionDate),
    index("markets_venue_idx").on(t.venue),
  ],
);

// ---- Append-only: market price/volume snapshots -------------------------------------
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.marketId),
    yesPrice: doublePrecision("yes_price"),
    noPrice: doublePrecision("no_price"),
    bestBid: doublePrecision("best_bid"),
    bestAsk: doublePrecision("best_ask"),
    midpoint: doublePrecision("midpoint"),
    spread: doublePrecision("spread"),
    volume: doublePrecision("volume"),
    liquidity: doublePrecision("liquidity"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => [index("market_snapshots_market_time_idx").on(t.marketId, t.capturedAt)],
);

// ---- Append-only: order book snapshots ----------------------------------------------
export const orderbookSnapshots = pgTable(
  "orderbook_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.marketId),
    tokenId: text("token_id").notNull(),
    bids: jsonb("bids").notNull(), // [{price, size}]
    asks: jsonb("asks").notNull(),
    hash: text("hash").notNull(), // stableHash of {bids,asks} to dedupe unchanged books
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orderbook_token_time_idx").on(t.tokenId, t.capturedAt)],
);

// ---- Append-only: backfilled CLOB price history -------------------------------------
export const marketPriceHistory = pgTable(
  "market_price_history",
  {
    tokenId: text("token_id").notNull(),
    t: timestamp("t", { withTimezone: true }).notNull(),
    price: doublePrecision("price").notNull(),
  },
  (t) => [uniqueIndex("price_history_token_t_idx").on(t.tokenId, t.t)],
);

// ---- Append-only: settled market outcomes (resolution truth) ------------------------
// Phase 2 foundation. A market settles exactly once, but the collector re-runs, so writes
// are idempotent on the (market_id, source) natural key via onConflictDoNothing — never
// overwriting a recorded settlement (append-only). For Kalshi the official settlement
// temperature is surfaced directly as `expiration_value`, captured here as settledValue.
export const marketResolutions = pgTable(
  "market_resolutions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.marketId),
    venue: text("venue").notNull(), // "kalshi" | "polymarket"
    source: text("source").notNull(), // "kalshi" (exchange settlement) | "nws_cli" (official)
    result: text("result"), // "yes" | "no" | "" (void) — the settled side
    settledValue: doublePrecision("settled_value"), // official measured value (e.g. high temp)
    settledValueUnit: text("settled_value_unit"), // "F" | "C"
    resolutionDate: timestamp("resolution_date", { withTimezone: true }), // target day
    settledAt: timestamp("settled_at", { withTimezone: true }), // exchange settlement_ts
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("market_resolutions_natural_key_idx").on(t.marketId, t.source),
    index("market_resolutions_date_idx").on(t.resolutionDate),
  ],
);

// ---- Dimension: weather stations ----------------------------------------------------
export const weatherStations = pgTable("weather_stations", {
  stationId: text("station_id").primaryKey(), // e.g. "KNYC", or open-meteo synthetic id
  name: text("name"),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  source: text("source").notNull(), // "nws" | "open-meteo"
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  raw: jsonb("raw"),
});

// ---- Append-only: forecasts (every revision) ----------------------------------------
export const forecasts = pgTable(
  "forecasts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stationId: text("station_id"), // nullable: open-meteo may key on lat/lon
    location: text("location"),
    source: text("source").notNull(), // "nws" | "open-meteo"
    targetDate: timestamp("target_date", { withTimezone: true }).notNull(), // forecast day
    forecastHighC: doublePrecision("forecast_high_c"),
    forecastLowC: doublePrecision("forecast_low_c"),
    variables: jsonb("variables"), // additional vars (humidity, wind, etc.)
    forecastRunAt: timestamp("forecast_run_at", { withTimezone: true }), // model run/issue time
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => [
    index("forecasts_station_target_idx").on(t.stationId, t.targetDate),
    index("forecasts_fetched_idx").on(t.fetchedAt),
  ],
);

// ---- Append-only: observations (hourly + daily) -------------------------------------
export const observations = pgTable(
  "observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stationId: text("station_id").notNull(),
    source: text("source").notNull(), // "nws" | "open-meteo"
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    tempC: doublePrecision("temp_c"),
    isHourly: boolean("is_hourly").notNull().default(true),
    dailyMaxTempC: doublePrecision("daily_max_temp_c"), // set on daily-summary rows
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => [
    index("observations_station_time_idx").on(t.stationId, t.observedAt),
    uniqueIndex("observations_natural_key_idx").on(
      t.stationId,
      t.source,
      t.observedAt,
      t.isHourly,
    ),
  ],
);

// ---- Auditability: collection runs --------------------------------------------------
export const collectionRuns = pgTable(
  "collection_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    collector: text("collector").notNull(), // "polymarket" | "weather" | "backfill:*"
    task: text("task").notNull(), // e.g. "markets" | "prices" | "nws-forecast"
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"), // running | ok | error
    recordsWritten: integer("records_written").notNull().default(0),
    errors: jsonb("errors"),
  },
  (t) => [index("collection_runs_collector_idx").on(t.collector, t.startedAt)],
);

// ---- Data quality results -----------------------------------------------------------
export const dataQualityChecks = pgTable(
  "data_quality_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: integer("run_id"),
    subject: text("subject"), // e.g. market_id or station_id the check ran against
    checkName: text("check_name").notNull(),
    passed: boolean("passed").notNull(),
    details: text("details"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dq_check_name_idx").on(t.checkName, t.checkedAt)],
);
