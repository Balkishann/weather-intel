import "dotenv/config";
import { getPool, closeDb } from "@weather/db";

/**
 * Phase 2 — Step 1c: resolution reconciliation (READ-ONLY, no trading logic).
 *
 * Tests a key Phase-1 assumption: do our NWS / Open-Meteo proxies track the OFFICIAL
 * settlement value Kalshi resolves on? For each settled daily-high temperature market
 * (`KXHIGH*`) we have the official high (`expiration_value`, °F) surfaced by Kalshi. We
 * compare it, per (city, target-day), against:
 *   - our observed daily max  = max(temp_c) over that day's observation snapshots
 *   - our last forecast high   = most-recently-fetched forecast_high_c for that target day
 *
 * Honest caveats (Phase 2 will tighten these):
 *   - Target day is parsed from the ticker (`-YYMONDD-`); the official "day" is local-time,
 *     but we bucket observations by UTC date — fine for capturing the afternoon high in the
 *     US, approximate elsewhere.
 *   - Overlap is limited to dates where BOTH a market settled AND we were already collecting
 *     weather. Coverage densifies as the schedule runs; uncovered city-days are reported, not
 *     hidden.
 *   - Observed daily max needs a full day of snapshots; partial-day coverage understates it.
 */
async function main() {
  const pool = getPool();
  const q = async (sql: string) => (await pool.query(sql)).rows;

  // One official high per (city, target-day): identical across an event's buckets, so max()
  // collapses them. Target day parsed from the ticker date segment, e.g. KXHIGHNY-26JUN12-T97.
  const officialCte = `
    official as (
      select m.location,
             to_date(substring(r.market_id from '-(\\d{2}[A-Z]{3}\\d{2})-'), 'YYMONDD') as d,
             max(r.settled_value) as official_high_f,
             count(*)::int as buckets
        from market_resolutions r
        join markets m on m.market_id = r.market_id
       where r.source = 'kalshi'
         and r.market_id like 'KXHIGH%'
         and r.settled_value is not null
         and m.location is not null
       group by 1, 2
    )`;

  // station_id -> location map (forecasts carry both; observations carry only station_id).
  const obsCte = `
    smap as (
      select distinct station_id, location from forecasts
       where location is not null and station_id is not null
    ),
    obs_daily as (
      select smap.location, o.observed_at::date as d,
             max(o.temp_c) as obs_max_c, count(*)::int as n
        from observations o
        join smap on smap.station_id = o.station_id
       group by 1, 2
    )`;

  const fcCte = `
    fc as (
      select location, target_date::date as d,
             (array_agg(forecast_high_c order by fetched_at desc))[1] as fc_high_c,
             (array_agg(source order by fetched_at desc))[1] as fc_src
        from forecasts
       where forecast_high_c is not null
       group by 1, 2
    )`;

  const joined = await q(`
    with ${officialCte}, ${obsCte}, ${fcCte}
    select o.location, o.d,
           o.official_high_f,
           (o.official_high_f - 32) * 5.0 / 9.0 as official_high_c,
           od.obs_max_c, od.n as obs_points,
           f.fc_high_c, f.fc_src
      from official o
      left join obs_daily od on od.location = o.location and od.d = o.d
      left join fc f on f.location = o.location and f.d = o.d
     order by o.d desc, o.location`);

  type Row = {
    location: string;
    d: Date;
    official_high_c: number;
    obs_max_c: number | null;
    obs_points: number | null;
    fc_high_c: number | null;
    fc_src: string | null;
  };
  const rows = joined as Row[];
  const covered = rows.filter((r) => r.obs_max_c !== null || r.fc_high_c !== null);
  const obsRows = rows.filter((r) => r.obs_max_c !== null);
  const fcRows = rows.filter((r) => r.fc_high_c !== null);

  const mae = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length : null;
  const obsErr = obsRows.map((r) => r.obs_max_c! - r.official_high_c);
  const fcErr = fcRows.map((r) => r.fc_high_c! - r.official_high_c);

  const c = (x: number | null, dp = 1) => (x === null ? "  — " : x.toFixed(dp));
  const line = "=".repeat(72);
  console.log(`\n${line}\n PHASE 2 — RESOLUTION RECONCILIATION (Kalshi daily-high vs proxies)\n${line}`);
  console.log(`Settled high city-days:        ${rows.length}`);
  console.log(`  with any proxy coverage:     ${covered.length}`);
  console.log(`  with observation coverage:   ${obsRows.length}`);
  console.log(`  with forecast coverage:      ${fcRows.length}`);

  console.log(`\nProxy error vs official high (°C; +/- = proxy hotter/cooler):`);
  console.log(`  observed daily max  MAE: ${c(mae(obsErr.map(Math.abs)))} °C  (n=${obsRows.length})`);
  console.log(`  last forecast high  MAE: ${c(mae(fcErr.map(Math.abs)))} °C  (n=${fcRows.length})`);

  console.log(`\nCovered city-days (official | obs-max Δ | forecast Δ):`);
  if (covered.length === 0) {
    console.log("  (no overlap yet — proxies and settlements share no city-day so far)");
  } else {
    console.log(
      `  ${"city".padEnd(16)} ${"day".padEnd(11)} ${"offHi°C".padStart(8)} ${"obsMax".padStart(7)} ${"Δobs".padStart(6)} ${"fcHi".padStart(6)} ${"Δfc".padStart(6)}  src`,
    );
    for (const r of covered) {
      const day = r.d.toISOString().slice(0, 10);
      const dObs = r.obs_max_c !== null ? r.obs_max_c - r.official_high_c : null;
      const dFc = r.fc_high_c !== null ? r.fc_high_c - r.official_high_c : null;
      console.log(
        `  ${r.location.padEnd(16)} ${day.padEnd(11)} ${c(r.official_high_c).padStart(8)} ${c(r.obs_max_c).padStart(7)} ${c(dObs).padStart(6)} ${c(r.fc_high_c).padStart(6)} ${c(dFc).padStart(6)}  ${r.fc_src ?? ""}`,
      );
    }
  }
  console.log(
    `\nNote: thin overlap is expected — weather collection began ~Jun 12; this densifies as\nthe schedule runs. Re-run after more settlements + observations accumulate.`,
  );
  console.log(`${line}\n`);

  await closeDb();
}

main().catch((err) => {
  console.error("reconciliation failed:", err);
  process.exit(1);
});
