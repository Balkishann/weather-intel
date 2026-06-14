import { z } from "zod";
import { toNumber, type HttpClient } from "@weather/shared";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

/**
 * Kalshi public market-data client (read-only endpoints need no auth, verified live).
 * Daily temperature markets live under the "Climate and Weather" category, tagged
 * "Daily temperature" (series like KXHIGHNY = "Highest temperature in NYC"). They resolve
 * on the NWS Climatological Report (Daily) in °F — a free, official resolution source.
 */

export const KalshiSeriesSchema = z
  .object({
    ticker: z.string(),
    title: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type KalshiSeries = z.infer<typeof KalshiSeriesSchema>;

export const KalshiMarketSchema = z
  .object({
    ticker: z.string(),
    event_ticker: z.string().optional(),
    series_ticker: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    yes_sub_title: z.string().optional(),
    status: z.string().optional(), // "open" | "closed" | "settled" | "finalized"
    rules_primary: z.string().optional(),
    close_time: z.string().optional(),
    expiration_time: z.string().optional(),
    // Settlement (present once finalized): result side + the official measured value.
    result: z.string().optional(), // "yes" | "no" | "" (void)
    expiration_value: z.union([z.string(), z.number()]).optional(), // measured value, e.g. "90.00"
    settlement_ts: z.string().optional(), // when Kalshi finalized the market
    floor_strike: z.union([z.string(), z.number()]).optional(),
    cap_strike: z.union([z.string(), z.number()]).optional(),
    strike_type: z.string().optional(), // "greater" | "between" | "less" ...
    // Prices arrive as dollar strings ("0.0200"); *_fp fields are fixed-point numbers.
    yes_bid_dollars: z.union([z.string(), z.number()]).optional(),
    yes_ask_dollars: z.union([z.string(), z.number()]).optional(),
    no_bid_dollars: z.union([z.string(), z.number()]).optional(),
    no_ask_dollars: z.union([z.string(), z.number()]).optional(),
    last_price_dollars: z.union([z.string(), z.number()]).optional(),
    liquidity_dollars: z.union([z.string(), z.number()]).optional(),
    volume_fp: z.union([z.string(), z.number()]).optional(),
    open_interest_fp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type KalshiMarket = z.infer<typeof KalshiMarketSchema>;

const OrderbookSchema = z.object({
  orderbook_fp: z
    .object({
      yes_dollars: z.array(z.tuple([z.string(), z.string()])).nullable().optional(),
      no_dollars: z.array(z.tuple([z.string(), z.string()])).nullable().optional(),
    })
    .optional(),
});

export interface KalshiBook {
  yes: { price: number; size: number }[];
  no: { price: number; size: number }[];
}

export class KalshiClient {
  constructor(private readonly http: HttpClient) {}

  /** Temperature series under "Climate and Weather" (tag "Daily temperature"). */
  async listTemperatureSeries(): Promise<KalshiSeries[]> {
    const raw = await this.http.getJson<{ series?: unknown[] }>(
      `${KALSHI_BASE}/series?category=${encodeURIComponent("Climate and Weather")}`,
    );
    const out: KalshiSeries[] = [];
    for (const r of raw.series ?? []) {
      const parsed = KalshiSeriesSchema.safeParse(r);
      if (!parsed.success) continue;
      const s = parsed.data;
      const isTemp =
        (s.tags ?? []).some((t) => /temperature/i.test(t)) ||
        /^KX(HIGH|LOW)/.test(s.ticker) ||
        /temperature/i.test(s.title ?? "");
      if (isTemp) out.push(s);
    }
    return out;
  }

  /** Open markets for a series, following the cursor. */
  async listOpenMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
    return this.listMarketsByStatus(seriesTicker, "open");
  }

  /**
   * Settled markets for a series (status "settled" returns finalized markets with a `result`
   * and `expiration_value`). Daily markets settle daily, so when run regularly a small page
   * cap captures recent settlements; `maxPages` bounds the historical walk.
   */
  async listSettledMarkets(seriesTicker: string, maxPages = 3): Promise<KalshiMarket[]> {
    return this.listMarketsByStatus(seriesTicker, "settled", maxPages);
  }

  private async listMarketsByStatus(
    seriesTicker: string,
    status: string,
    maxPages = Infinity,
  ): Promise<KalshiMarket[]> {
    const out: KalshiMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const qs = new URLSearchParams({ series_ticker: seriesTicker, status, limit: "200" });
      if (cursor) qs.set("cursor", cursor);
      const raw = await this.http.getJson<{ markets?: unknown[]; cursor?: string }>(
        `${KALSHI_BASE}/markets?${qs.toString()}`,
      );
      for (const m of raw.markets ?? []) {
        const parsed = KalshiMarketSchema.safeParse(m);
        if (parsed.success) out.push(parsed.data);
      }
      if (!raw.cursor || (raw.markets ?? []).length === 0) break;
      cursor = raw.cursor;
    }
    return out;
  }

  /** Fresh single-market detail (live prices/volume). */
  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    const raw = await this.http.getJson<{ market?: unknown }>(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`,
    );
    const parsed = KalshiMarketSchema.safeParse(raw.market ?? raw);
    return parsed.success ? parsed.data : null;
  }

  async getOrderbook(ticker: string, depth = 10): Promise<KalshiBook> {
    const raw = await this.http.getJson<unknown>(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`,
    );
    const ob = OrderbookSchema.parse(raw).orderbook_fp;
    const map = (rows: [string, string][] | null | undefined) =>
      (rows ?? []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
    return { yes: map(ob?.yes_dollars), no: map(ob?.no_dollars) };
  }
}

/** Normalise Kalshi price fields into the common snapshot shape. */
export function priceSummary(m: KalshiMarket): {
  yesPrice: number | null;
  noPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  volume: number | null;
  liquidity: number | null;
} {
  const bestBid = toNumber(m.yes_bid_dollars);
  const bestAsk = toNumber(m.yes_ask_dollars);
  const last = toNumber(m.last_price_dollars);
  const midpoint =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  // Prefer the live book midpoint (current implied probability) over a possibly-stale
  // last trade.
  const yesPrice = midpoint ?? last;
  return {
    yesPrice,
    noPrice: yesPrice !== null ? 1 - yesPrice : null,
    bestBid,
    bestAsk,
    midpoint,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    volume: toNumber(m.volume_fp),
    liquidity: toNumber(m.liquidity_dollars),
  };
}
