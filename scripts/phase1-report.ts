import "dotenv/config";
import { getPool, closeDb } from "@weather/db";

/**
 * Phase 1 coverage + data-quality summary. Read-only; safe to run anytime.
 * Proves the dataset is accumulating and surfaces coverage gaps (e.g. temperature
 * markets with no mapped resolution station).
 */
async function main() {
  const pool = getPool();
  const q = async (sql: string) => (await pool.query(sql)).rows;

  const [markets] = await q(
    `select count(*)::int total,
            count(*) filter (where is_temperature_market)::int temp
       from markets`,
  );
  const byVenue = await q(
    `select venue,
            count(*)::int total,
            count(*) filter (where is_temperature_market)::int temp
       from markets group by venue order by venue`,
  );
  const bySource = await q(
    `select coalesce(resolution_source,'(unparsed)') src, count(*)::int n
       from markets where is_temperature_market group by resolution_source order by n desc`,
  );
  const [snaps] = await q(`select count(*)::int n from market_snapshots`);
  const [books] = await q(`select count(*)::int n from orderbook_snapshots`);
  const [hist] = await q(`select count(*)::int n from market_price_history`);
  const [fc] = await q(`select count(*)::int n from forecasts`);
  const [obs] = await q(`select count(*)::int n from observations`);

  const forecastBySource = await q(
    `select source, count(*)::int n from forecasts group by source order by source`,
  );
  const revisions = await q(
    `select station_id, target_date::date d, count(*)::int revisions
       from forecasts group by station_id, target_date
       having count(*) > 1 order by revisions desc limit 10`,
  );

  const dq = await q(
    `select check_name,
            count(*)::int total,
            count(*) filter (where passed)::int passed,
            count(distinct subject) filter (where not passed)::int distinct_fails
       from data_quality_checks group by check_name order by check_name`,
  );
  // "Gap" checks (e.g. city_geocoded, temp_market_has_location) only ever record FAILURES,
  // so a naive passed/total reads a misleading 0%. Split them out and report the count of
  // DISTINCT failing subjects (re-recorded each run, so dedupe) instead of a pass-rate.
  const passRateChecks = dq.filter((r) => r.passed > 0 || r.total === 0);
  const gapChecks = dq.filter((r) => r.passed === 0 && r.total > 0);
  const snapsByVenue = await q(
    `select m.venue, count(*)::int n
       from market_snapshots s join markets m on m.market_id = s.market_id
      group by m.venue order by n desc`,
  );
  const missingStation = await q(
    `select market_id, question from markets
      where is_temperature_market and resolution_station is null limit 20`,
  );
  const runs = await q(
    `select collector, task, status, records_written, started_at
       from collection_runs order by started_at desc limit 10`,
  );

  const line = "=".repeat(60);
  console.log(`\n${line}\n PHASE 1 — DATA COLLECTION REPORT\n${line}`);
  console.log(`Markets tracked:        ${markets.total} (temperature: ${markets.temp})`);
  console.log(`  (Kalshi is the anchored venue; Polymarket rows are historical/parked)`);
  for (const v of byVenue)
    console.log(`  venue ${String(v.venue).padEnd(12)} ${v.total} (temp: ${v.temp})`);
  console.log(`Resolution sources (temp markets):`);
  for (const s of bySource) console.log(`  ${String(s.src).padEnd(20)} ${s.n}`);
  console.log(`Market snapshots:       ${snaps.n}`);
  for (const v of snapsByVenue)
    console.log(`  venue ${String(v.venue).padEnd(12)} ${v.n}`);
  console.log(`Order book snapshots:   ${books.n}`);
  console.log(`Price-history points:   ${hist.n}`);
  console.log(`Forecast rows:          ${fc.n}`);
  console.log(`Observation rows:       ${obs.n}`);

  console.log(`\nForecasts by source:`);
  for (const r of forecastBySource) console.log(`  ${r.source.padEnd(12)} ${r.n}`);

  console.log(`\nTop forecast-revision counts (target captured >1x):`);
  if (revisions.length === 0) console.log("  (none yet — need >1 forecast fetch)");
  for (const r of revisions)
    console.log(`  ${String(r.station_id).padEnd(8)} ${r.d}  ${r.revisions} revisions`);

  console.log(`\nData-quality pass-rates (passed / total):`);
  if (passRateChecks.length === 0) console.log("  (none recorded yet)");
  for (const r of passRateChecks) {
    const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
    console.log(`  ${r.check_name.padEnd(28)} ${r.passed}/${r.total} (${pct}%)`);
  }

  console.log(`\nCoverage gaps (distinct subjects failing — not a pass-rate):`);
  if (gapChecks.length === 0) console.log("  (none)");
  for (const r of gapChecks)
    console.log(`  ${r.check_name.padEnd(28)} ${r.distinct_fails} distinct`);

  console.log(`\nTemperature markets MISSING a resolution station: ${missingStation.length}`);
  for (const r of missingStation)
    console.log(`  - ${r.market_id}: ${String(r.question ?? "").slice(0, 70)}`);

  console.log(`\nRecent collection runs:`);
  for (const r of runs)
    console.log(
      `  ${r.started_at.toISOString?.() ?? r.started_at}  ${String(r.collector).padEnd(16)} ${String(r.task).padEnd(14)} ${r.status} (${r.records_written})`,
    );
  console.log(`${line}\n`);

  await closeDb();
}

main().catch((err) => {
  console.error("report failed:", err);
  process.exit(1);
});
