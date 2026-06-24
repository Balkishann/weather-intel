import "dotenv/config";
import { getPool, closeDb } from "@weather/db";

/**
 * Phase 2 — Step 2: price-vs-information LATENCY analysis (READ-ONLY, no trading logic).
 *
 * Tests the project's core hypothesis (CLAUDE.md): are there windows where public weather
 * information already implies a Kalshi daily-high outcome BEFORE the market price moves to
 * match? We assume nothing — prices may well lead the proxies, which is a valid result.
 *
 * v1 centers on the single cleanest, irreversible signal from docs/LATENCY_ANALYSIS_DESIGN.md:
 * the **observed-max strike crossing**. For a "≥ X°F or above" (T-bucket) market, the moment
 * our running intraday observed max first reaches the strike, YES is LOCKED — a daily high can
 * only go up, never down. We measure:
 *
 *   - t_info  = first observation time on the target day where temp ≥ strike   (YES locks)
 *   - t_mkt   = first price snapshot at/after t_info with yes_price ≥ 1 − TOL    (market agrees)
 *   - latency Δt = t_mkt − t_info  (0 if the market already led; right-censored if never)
 *   - mispricing_at_lock = 1 − yes_price at the snapshot just as info locked      (the gap)
 *   - cost    = best_ask − best_bid at that snapshot (does the gap clear the spread?)
 *   - truth   = does the YES-lock agree with market_resolutions.result?
 *
 * Honest scope / caveats (carried from the reconciliation + design note):
 *   - Only "≥ X or above" T-buckets give a clean monotone P(high ≥ X); range/below buckets are
 *     left for a later iteration (noted, not faked).
 *   - Proxy↔official has ~1.4 °C MAE (Jun-20 gate). A crossing within ~MAE of the strike is
 *     uncertain; we report the strike-exceed margin so thin crossings can be judged.
 *   - Snapshot cadence (~15 min) lower-bounds the latency we can resolve.
 *   - Observations bucketed by UTC date; fine for US afternoon highs (these are US cities).
 *   - LA before its 2026-06-20 LAX coord fix is excluded (station-mismatch inflated the proxy).
 *   - Only OPEN markets get price snapshots, so this is naturally the live trading window.
 */

const TOL = 0.05; // price within 5¢ of 1.00 counts as "market has priced the locked outcome"
const MARGIN_C = 0.0; // min °C the obs must exceed the strike to count the crossing (0 = raw)
// LA's coordinate fix (downtown→LAX) shipped 2026-06-20; earlier LA proxy days are biased hot.
const LA_FIX_DATE = "2026-06-20";

type Mkt = {
  market_id: string;
  location: string;
  d: string; // target day (UTC date)
  strike_f: number;
  strike_c: number;
  result: string | null;
  settled_value_f: number | null;
};
type ObsPt = { location: string; d: string; observed_at: Date; temp_c: number };
type Snap = {
  market_id: string;
  captured_at: Date;
  yes_price: number | null;
  best_bid: number | null;
  best_ask: number | null;
};

async function main() {
  const pool = getPool();
  const q = async <T>(sql: string): Promise<T[]> => (await pool.query(sql)).rows as T[];

  // --- Universe: settled "≥ X or above" daily-high buckets with a parseable strike ---------
  const universe = await q<Mkt>(`
    select m.market_id,
           m.location,
           to_char(to_date(substring(r.market_id from '-(\\d{2}[A-Z]{3}\\d{2})-'), 'YYMONDD'),'YYYY-MM-DD') as d,
           (substring(m.threshold from '(\\d+)\\D*\\s+or above'))::int as strike_f,
           ((substring(m.threshold from '(\\d+)\\D*\\s+or above'))::int - 32) * 5.0/9.0 as strike_c,
           r.result,
           r.settled_value as settled_value_f
      from market_resolutions r
      join markets m on m.market_id = r.market_id
     where r.source = 'kalshi'
       and r.market_id like 'KXHIGH%'
       and m.location is not null
       and m.threshold ilike '%or above%'
       and substring(m.threshold from '(\\d+)\\D*\\s+or above') is not null
  `);

  if (universe.length === 0) {
    console.log("No qualifying '≥X or above' settled markets yet. Nothing to analyze.");
    await closeDb();
    return;
  }
  const days = universe.map((m) => m.d).sort();
  const minDay = days[0]!;

  // --- Observations per (location, day): station_id→location via forecasts, like reconcile --
  const obs = await q<ObsPt>(`
    with smap as (
      select distinct station_id, location from forecasts
       where location is not null and station_id is not null
    )
    select smap.location,
           to_char(o.observed_at::date,'YYYY-MM-DD') as d,
           o.observed_at,
           o.temp_c
      from observations o
      join smap on smap.station_id = o.station_id
     where o.temp_c is not null
       and o.observed_at::date >= date '${minDay}'
     order by smap.location, o.observed_at
  `);

  // --- Price snapshots for the universe markets --------------------------------------------
  const snaps = await q<Snap>(`
    with uni as (
      select distinct r.market_id
        from market_resolutions r
        join markets m on m.market_id = r.market_id
       where r.source='kalshi' and r.market_id like 'KXHIGH%'
         and m.location is not null and m.threshold ilike '%or above%'
    )
    select s.market_id, s.captured_at, s.yes_price, s.best_bid, s.best_ask
      from market_snapshots s
      join uni on uni.market_id = s.market_id
     where s.yes_price is not null
     order by s.market_id, s.captured_at
  `);

  // Index obs by location|day, snaps by market_id.
  const obsByKey = new Map<string, ObsPt[]>();
  for (const o of obs) {
    const k = `${o.location}|${o.d}`;
    (obsByKey.get(k) ?? obsByKey.set(k, []).get(k)!).push(o);
  }
  const snapByMkt = new Map<string, Snap[]>();
  for (const s of snaps) {
    (snapByMkt.get(s.market_id) ?? snapByMkt.set(s.market_id, []).get(s.market_id)!).push(s);
  }

  type Result = {
    m: Mkt;
    tInfo: Date;
    marginC: number; // how far the crossing obs exceeded the strike
    pMktAtLock: number; // yes_price at the last snapshot ≤ tInfo (the gap = 1 − this)
    spreadAtLock: number | null;
    latencyMin: number | null; // minutes until yes_price ≥ 1−TOL; null = censored (never)
    censored: boolean;
    agree: boolean | null; // YES-lock vs settled result
  };
  const locked: Result[] = [];
  let noPrice = 0;
  let noObs = 0;
  let excludedLa = 0;
  let neverCrossed = 0;

  for (const m of universe) {
    // Exclude LA days before the LAX coord fix (biased-hot proxy).
    if (m.location === "Los Angeles" && m.d < LA_FIX_DATE) {
      excludedLa++;
      continue;
    }
    const series = obsByKey.get(`${m.location}|${m.d}`);
    if (!series || series.length === 0) {
      noObs++;
      continue;
    }
    // First obs that reaches the strike (YES locks). Daily max is monotone, so the first
    // point ≥ strike is the lock instant.
    const cross = series.find((o) => o.temp_c >= m.strike_c + MARGIN_C);
    if (!cross) {
      neverCrossed++; // obs never reached strike (likely a NO; v1 reports YES-locks only)
      continue;
    }
    const mktSnaps = snapByMkt.get(m.market_id);
    if (!mktSnaps || mktSnaps.length === 0) {
      noPrice++;
      continue;
    }
    const tInfo = new Date(cross.observed_at);

    // Price just as info locked: last snapshot at/before tInfo (else the first snapshot).
    let atLock: Snap | undefined;
    for (const s of mktSnaps) {
      if (new Date(s.captured_at) <= tInfo) atLock = s;
      else break;
    }
    atLock = atLock ?? mktSnaps[0];
    const pMktAtLock = atLock!.yes_price ?? 0;
    const spreadAtLock =
      atLock!.best_ask != null && atLock!.best_bid != null
        ? atLock!.best_ask - atLock!.best_bid
        : null;

    // Latency: first snapshot at/after tInfo with yes_price ≥ 1−TOL.
    const conv = mktSnaps.find(
      (s) => new Date(s.captured_at) >= tInfo && (s.yes_price ?? 0) >= 1 - TOL,
    );
    let latencyMin: number | null;
    let censored = false;
    if (pMktAtLock >= 1 - TOL) {
      latencyMin = 0; // market already led / coincident
    } else if (conv) {
      latencyMin = (new Date(conv.captured_at).getTime() - tInfo.getTime()) / 60000;
    } else {
      latencyMin = null; // right-censored: never converged before the last snapshot
      censored = true;
    }

    locked.push({
      m,
      tInfo,
      marginC: cross.temp_c - m.strike_c,
      pMktAtLock,
      spreadAtLock,
      latencyMin,
      censored,
      agree: m.result ? m.result === "yes" : null,
    });
  }

  // ---- Report ------------------------------------------------------------------------------
  const line = "=".repeat(78);
  const fmt = (x: number | null, dp = 1) => (x == null ? "  —" : x.toFixed(dp));
  console.log(`\n${line}\n PHASE 2 — PRICE-vs-INFORMATION LATENCY (Kalshi daily-high ≥X buckets)\n${line}`);
  console.log(`Universe (settled '≥X or above' buckets):     ${universe.length}`);
  console.log(`  YES-locked (obs reached strike):            ${locked.length}`);
  console.log(`  obs never reached strike (NO-side, v1 skip):${neverCrossed}`);
  console.log(`  no proxy obs for that city-day:             ${noObs}`);
  console.log(`  no price snapshots while open:              ${noPrice}`);
  console.log(`  LA days excluded (pre-LAX-fix):             ${excludedLa}`);

  if (locked.length === 0) {
    console.log(`\nNo YES-locked markets with both obs + price coverage yet. Re-run as data densifies.`);
    console.log(`${line}\n`);
    await closeDb();
    return;
  }

  // Aggregates
  const settled = locked.filter((r) => !r.censored && r.latencyMin != null);
  const lats = settled.map((r) => r.latencyMin!).sort((a, b) => a - b);
  const median = lats.length ? lats[Math.floor(lats.length / 2)]! : null;
  const mean = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : null;
  const leadOrInstant = locked.filter((r) => r.latencyMin === 0).length;
  const censoredN = locked.filter((r) => r.censored).length;
  const agreeN = locked.filter((r) => r.agree === true).length;
  const disagreeN = locked.filter((r) => r.agree === false).length;
  const gaps = locked.map((r) => 1 - r.pMktAtLock);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const clearedCost = locked.filter(
    (r) => r.spreadAtLock != null && 1 - r.pMktAtLock > r.spreadAtLock,
  ).length;

  console.log(`\n--- Latency (time from YES-lock to market pricing it ≥ ${(1 - TOL).toFixed(2)}) ---`);
  console.log(`  already led / instant (Δt=0):   ${leadOrInstant} / ${locked.length}`);
  console.log(`  converged later (measurable Δt): ${settled.length}`);
  console.log(`    median Δt: ${fmt(median, 0)} min     mean Δt: ${fmt(mean, 0)} min`);
  console.log(`  never converged before last snap (censored): ${censoredN}`);
  console.log(`\n--- Mispricing at lock (gap = 1 − yes_price when YES became certain) ---`);
  console.log(`  mean gap: ${fmt(meanGap * 100, 1)}¢     gap exceeded the spread in ${clearedCost}/${locked.length} cases`);
  console.log(`\n--- Truth check (YES-lock vs official settled result) ---`);
  console.log(`  agree: ${agreeN}   disagree: ${disagreeN}   (disagree ⇒ proxy crossed but official didn't — MAE risk)`);

  // By-city breakdown
  const byCity = new Map<string, { n: number; led: number; gapSum: number }>();
  for (const r of locked) {
    const e = byCity.get(r.m.location) ?? { n: 0, led: 0, gapSum: 0 };
    e.n++;
    if (r.latencyMin === 0) e.led++;
    e.gapSum += 1 - r.pMktAtLock;
    byCity.set(r.m.location, e);
  }
  console.log(`\n--- By city (n locked | led-instant | mean gap¢) ---`);
  for (const [city, e] of [...byCity.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${city.padEnd(16)} n=${String(e.n).padStart(3)}  led=${String(e.led).padStart(3)}  gap=${fmt((e.gapSum / e.n) * 100, 1)}¢`);
  }

  // Detail sample (largest mispricing-at-lock first — the most interesting cases)
  const detail = [...locked].sort((a, b) => 1 - b.pMktAtLock - (1 - a.pMktAtLock)).slice(0, 25);
  console.log(`\n--- Top mispricing-at-lock cases (gap = how underpriced YES was when it locked) ---`);
  console.log(
    `  ${"city".padEnd(15)} ${"day".padEnd(10)} ${"≥°F".padStart(4)} ${"res".padStart(3)} ${"p@lock".padStart(6)} ${"gap¢".padStart(5)} ${"sprd".padStart(5)} ${"Δt min".padStart(7)} ${"mgn°C".padStart(6)}`,
  );
  for (const r of detail) {
    const lat = r.censored ? ">cens" : r.latencyMin === 0 ? "0" : fmt(r.latencyMin, 0);
    console.log(
      `  ${r.m.location.padEnd(15)} ${r.m.d.padEnd(10)} ${String(r.m.strike_f).padStart(4)} ${(r.m.result ?? "—").padStart(3)} ${fmt(r.pMktAtLock, 2).padStart(6)} ${fmt((1 - r.pMktAtLock) * 100, 0).padStart(5)} ${(r.spreadAtLock == null ? "—" : fmt(r.spreadAtLock * 100, 0)).padStart(5)} ${lat.padStart(7)} ${fmt(r.marginC, 1).padStart(6)}`,
    );
  }

  console.log(
    `\nVerdict scaffold: 'led/instant' = market already priced the locked outcome (prices lead);` +
      `\nlarge 'gap' with positive Δt = public info led price (the hypothesized edge). Read-only —` +
      `\nno signal is acted on. Interpret against the ~1.4 °C proxy MAE and ~15-min snapshot cadence.`,
  );
  console.log(`${line}\n`);
  await closeDb();
}

main().catch((err) => {
  console.error("latency analysis failed:", err);
  process.exit(1);
});
