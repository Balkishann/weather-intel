import {
  Repo,
  type Database,
} from "@weather/db";
import {
  checkComplementaryPrices,
  checkPriceInRange,
  stableHash,
  toNumber,
  type CheckResult,
  type Logger,
  type HttpClient,
} from "@weather/shared";
import { GammaClient, decodeJsonArray, type GammaMarket } from "./gamma.js";
import { ClobClient, summariseBook } from "./clob.js";
import { analyzeMarket } from "./temperature.js";

/**
 * Phase 1 Polymarket collection. Two tasks:
 *   - markets: discover all active markets, classify temperature ones, upsert metadata.
 *   - prices:  for temperature markets, snapshot prices + order books (append-only).
 */
export class PolymarketCollector {
  private readonly repo: Repo;
  private readonly gamma: GammaClient;
  private readonly clob: ClobClient;

  constructor(
    db: Database,
    http: HttpClient,
    private readonly log: Logger,
  ) {
    this.repo = new Repo(db);
    this.gamma = new GammaClient(http);
    this.clob = new ClobClient(http);
  }

  /**
   * Discover daily-temperature markets via the weather-tagged events endpoint, fetch full
   * detail per market (events omit clobTokenIds/prices), and upsert metadata. Verified
   * against the live API: events titled "Highest temperature in <City> on <date>?" each
   * hold ~11 threshold markets resolving on Wunderground.
   */
  async collectMarkets(): Promise<void> {
    const runId = await this.repo.startRun("polymarket", "markets");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const events = await this.gamma.listEventsByTag("weather");
      for (const event of events) {
        const isTempEvent = /highest temperature|high temp|temperature/i.test(
          event.title ?? "",
        );
        if (!isTempEvent) continue;

        for (const lite of event.markets) {
          // Fetch full detail (events omit clobTokenIds / outcomePrices).
          const detail = await this.gamma.getMarket(lite.id).catch(() => null);
          const market = detail?.market ?? lite;
          const raw = detail?.raw ?? lite;
          const info = analyzeMarket(market, event.title);
          const tokenIds = decodeJsonArray(market.clobTokenIds);

          await this.repo.upsertMarket({
            marketId: market.conditionId ?? market.id,
            slug: market.slug ?? null,
            question: market.question ?? null,
            eventTitle: event.title ?? null,
            location: info.location,
            resolutionDate: market.endDate ? new Date(market.endDate) : null,
            resolutionStation: info.resolutionStation,
            resolutionSource: info.resolutionSource,
            resolutionUrl: info.resolutionUrl,
            resolutionRules: market.description ?? null,
            threshold:
              (market as { groupItemTitle?: string }).groupItemTitle ?? null,
            contractStructure: "binary",
            isTemperatureMarket: info.isTemperature,
            clobTokenIds: tokenIds,
            raw: raw as object,
          });

          if (info.isTemperature && !info.resolutionStation) {
            checks.push({
              subject: market.conditionId ?? market.id,
              checkName: "temp_market_has_station",
              passed: false,
              details: "temperature market without parsed resolution station",
            });
          }
          if (info.isTemperature && !info.location) {
            checks.push({
              subject: market.conditionId ?? market.id,
              checkName: "temp_market_has_location",
              passed: false,
              details: "temperature market without parsed city",
            });
          }
          count++;
        }
      }
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info(
        { count, events: events.length, gaps: checks.length },
        "markets collected",
      );
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, {
        message: (err as Error).message,
      });
      throw err;
    }
  }

  /** Snapshot prices + order books for temperature markets. */
  async collectPrices(): Promise<void> {
    const runId = await this.repo.startRun("polymarket", "prices");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const temps = await this.repo.temperatureMarkets();
      for (const m of temps) {
        const tokenIds = (m.clobTokenIds as string[] | null) ?? [];
        const outcomePrices = decodeJsonArray(
          (m.raw as GammaMarket | null)?.outcomePrices,
        );
        const yesPrice = toNumber(outcomePrices[0]);
        const noPrice = toNumber(outcomePrices[1]);

        // Order book + midpoint from the YES token (first token id), if present.
        let summary = {
          bestBid: null as number | null,
          bestAsk: null as number | null,
          midpoint: null as number | null,
          spread: null as number | null,
        };
        const yesToken = tokenIds[0];
        if (yesToken) {
          try {
            const book = await this.clob.getBook(yesToken);
            summary = summariseBook(book);
            const hash = stableHash({ bids: book.bids, asks: book.asks });
            await this.repo.insertOrderbookSnapshot({
              marketId: m.marketId,
              tokenId: yesToken,
              bids: book.bids,
              asks: book.asks,
              hash,
            });
          } catch (err) {
            this.log.warn(
              { marketId: m.marketId, err: (err as Error).message },
              "order book fetch failed",
            );
          }
        }

        await this.repo.insertMarketSnapshot({
          marketId: m.marketId,
          yesPrice,
          noPrice,
          bestBid: summary.bestBid,
          bestAsk: summary.bestAsk,
          midpoint: summary.midpoint,
          spread: summary.spread,
          volume: toNumber((m.raw as GammaMarket | null)?.volume),
          liquidity: toNumber((m.raw as GammaMarket | null)?.liquidity),
        });

        checks.push(...priceChecks(m.marketId, yesPrice, noPrice));
        count++;
      }
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info(
        { count, failedChecks: checks.filter((c) => !c.passed).length },
        "price snapshots collected",
      );
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, {
        message: (err as Error).message,
      });
      throw err;
    }
  }
}

function priceChecks(
  marketId: string,
  yes: number | null,
  no: number | null,
): { subject: string; checkName: string; passed: boolean; details?: string }[] {
  const results: CheckResult[] = [
    checkPriceInRange("yes_price_range", yes),
    checkPriceInRange("no_price_range", no),
    checkComplementaryPrices(yes, no),
  ];
  return results.map((r) => ({ subject: marketId, ...r }));
}
