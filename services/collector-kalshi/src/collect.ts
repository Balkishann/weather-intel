import { Repo, type Database } from "@weather/db";
import {
  checkComplementaryPrices,
  checkPriceInRange,
  checkTemperaturePlausible,
  stableHash,
  type Logger,
  type HttpClient,
} from "@weather/shared";
import { KalshiClient, priceSummary } from "./kalshi.js";
import {
  analyzeKalshiMarket,
  fToC,
  isSettled,
  parseSettlement,
  threshold,
} from "./temperature.js";

/**
 * Phase 1 Kalshi collection. Discovers daily-temperature series under "Climate and Weather",
 * upserts each threshold market's metadata, and appends price + order-book snapshots. Markets
 * resolve on the NWS Climatological Report (Daily) — recorded as resolutionSource "nws_cli".
 */
export class KalshiCollector {
  private readonly repo: Repo;
  private readonly kalshi: KalshiClient;

  constructor(
    db: Database,
    http: HttpClient,
    private readonly log: Logger,
  ) {
    this.repo = new Repo(db);
    this.kalshi = new KalshiClient(http);
  }

  /** Discover temperature series + markets and upsert metadata. */
  async collectMarkets(): Promise<void> {
    const runId = await this.repo.startRun("kalshi", "markets");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const series = await this.kalshi.listTemperatureSeries();
      const rows: Parameters<Repo["upsertMarkets"]>[0] = [];
      for (const s of series) {
        const markets = await this.kalshi.listOpenMarkets(s.ticker);
        for (const m of markets) {
          const info = analyzeKalshiMarket(m, s.title);
          // Phase 1 scope: persist ONLY daily-temperature markets. Skip any non-temperature
          // market that slips through the series filter so the price loop never touches it.
          if (!info.isTemperature) continue;
          rows.push({
            marketId: m.ticker,
            venue: "kalshi",
            slug: m.ticker,
            question: m.title ?? null,
            eventTitle: s.title ?? null,
            location: info.location,
            resolutionDate: m.expiration_time
              ? new Date(m.expiration_time)
              : m.close_time
                ? new Date(m.close_time)
                : null,
            resolutionStation: info.resolutionStation,
            resolutionSource: info.resolutionSource,
            resolutionUrl: null,
            resolutionRules: m.rules_primary ?? null,
            threshold: threshold(m),
            contractStructure: "binary",
            isTemperatureMarket: info.isTemperature,
            clobTokenIds: null,
            raw: m as object,
          });
          if (!info.location) {
            checks.push({
              subject: m.ticker,
              checkName: "temp_market_has_location",
              passed: false,
              details: "could not parse city from series/market title",
            });
          }
          count++;
        }
      }
      // Bulk-flush all discovered markets in batched upserts (not one round-trip each).
      await this.repo.upsertMarkets(rows);
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info({ count, series: series.length, gaps: checks.length }, "kalshi markets collected");
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, { message: (err as Error).message });
      throw err;
    }
  }

  /**
   * Capture settled-market resolution truth. For each temperature series we fetch recently
   * settled markets; finalized markets carry both the outcome (`result`) and the official
   * settlement value (`expiration_value`, °F — the NWS-CLI high/low Kalshi resolved on).
   * Append-only + idempotent: already-recorded (market, "kalshi") pairs are skipped.
   */
  async collectResolutions(): Promise<void> {
    const runId = await this.repo.startRun("kalshi", "resolutions");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const series = await this.kalshi.listTemperatureSeries();
      const already = await this.repo.resolvedMarketIds("kalshi");
      const marketRows: Parameters<Repo["upsertMarkets"]>[0] = [];
      const resolutionRows: Parameters<Repo["insertMarketResolutions"]>[0] = [];

      for (const s of series) {
        const settled = await this.kalshi.listSettledMarkets(s.ticker);
        for (const m of settled) {
          const info = analyzeKalshiMarket(m, s.title);
          if (!info.isTemperature || !isSettled(m)) continue;
          if (already.has(m.ticker)) continue;

          const resolutionDate = m.expiration_time
            ? new Date(m.expiration_time)
            : m.close_time
              ? new Date(m.close_time)
              : null;
          // Upsert the settled market into the dimension so the FK holds and metadata is
          // enriched even for markets we never saw while open.
          marketRows.push({
            marketId: m.ticker,
            venue: "kalshi",
            slug: m.ticker,
            question: m.title ?? null,
            eventTitle: s.title ?? null,
            location: info.location,
            resolutionDate,
            resolutionStation: info.resolutionStation,
            resolutionSource: info.resolutionSource,
            resolutionUrl: null,
            resolutionRules: m.rules_primary ?? null,
            threshold: threshold(m),
            contractStructure: "binary",
            isTemperatureMarket: info.isTemperature,
            clobTokenIds: null,
            raw: m as object,
          });

          const settlement = parseSettlement(m);
          resolutionRows.push({
            marketId: m.ticker,
            venue: "kalshi",
            source: "kalshi",
            result: settlement.result,
            settledValue: settlement.settledValueF,
            settledValueUnit: "F",
            resolutionDate,
            settledAt: settlement.settledAt,
            raw: m as object,
          });
          if (settlement.settledValueF !== null) {
            checks.push({
              subject: m.ticker,
              ...checkTemperaturePlausible(
                "settled_value_plausible",
                fToC(settlement.settledValueF),
              ),
            });
          }
          count++;
        }
      }

      await this.repo.upsertMarkets(marketRows);
      await this.repo.insertMarketResolutions(resolutionRows);
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info(
        { count, series: series.length, failedChecks: checks.filter((c) => !c.passed).length },
        "kalshi resolutions collected",
      );
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, { message: (err as Error).message });
      throw err;
    }
  }

  /** Snapshot prices + order books for Kalshi temperature markets. */
  async collectPrices(): Promise<void> {
    const runId = await this.repo.startRun("kalshi", "prices");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      // Only OPEN markets: settled markets (now in the dimension via collectResolutions) have
      // no live order book, and polling all ~17k of them blows past the CI job timeout.
      const markets = await this.repo.pricableKalshiMarkets();
      // Phase A — fetch all live prices/books over HTTP and build snapshot rows in memory.
      // No DB writes here, so pooled connections never sit idle through the throttled HTTP
      // loop (which is what triggered Neon to drop them mid-run).
      const marketRows: Parameters<Repo["insertMarketSnapshots"]>[0] = [];
      const bookRows: Parameters<Repo["insertOrderbookSnapshots"]>[0] = [];
      for (const m of markets) {
        try {
          // Use prices captured at discovery (minutes old) as the base, then overlay the
          // live order book below. Skipping a per-market market re-read halves prices-phase
          // HTTP (~1000 → ~500 requests) with no data loss — the book gives live bid/ask.
          let snap = priceSummary(m.raw as Parameters<typeof priceSummary>[0]);
          try {
            const book = await this.kalshi.getOrderbook(m.marketId);
            const bestBid = book.yes.length ? Math.max(...book.yes.map((l) => l.price)) : snap.bestBid;
            const bestAsk = book.no.length
              ? 1 - Math.max(...book.no.map((l) => l.price))
              : snap.bestAsk;
            snap = {
              ...snap,
              bestBid,
              bestAsk,
              midpoint:
                bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : snap.midpoint,
              spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : snap.spread,
            };
            bookRows.push({
              marketId: m.marketId,
              tokenId: m.marketId,
              bids: book.yes,
              asks: book.no,
              hash: stableHash(book),
            });
          } catch (err) {
            this.log.warn({ ticker: m.marketId, err: (err as Error).message }, "kalshi orderbook failed");
          }

          marketRows.push({
            marketId: m.marketId,
            yesPrice: snap.yesPrice,
            noPrice: snap.noPrice,
            bestBid: snap.bestBid,
            bestAsk: snap.bestAsk,
            midpoint: snap.midpoint,
            spread: snap.spread,
            volume: snap.volume,
            liquidity: snap.liquidity,
          });
          checks.push(
            { subject: m.marketId, ...checkPriceInRange("yes_price_range", snap.yesPrice) },
            { subject: m.marketId, ...checkComplementaryPrices(snap.yesPrice, snap.noPrice) },
          );
          count++;
        } catch (err) {
          // One market failing (e.g. transient HTTP error) must not abort the cycle.
          this.log.warn({ ticker: m.marketId, err: (err as Error).message }, "kalshi market price fetch failed");
        }
      }
      // Phase B — flush everything to Postgres in a few batched, back-to-back inserts.
      await this.repo.insertOrderbookSnapshots(bookRows);
      await this.repo.insertMarketSnapshots(marketRows);
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info(
        { count, failedChecks: checks.filter((c) => !c.passed).length },
        "kalshi price snapshots collected",
      );
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, { message: (err as Error).message });
      throw err;
    }
  }
}
