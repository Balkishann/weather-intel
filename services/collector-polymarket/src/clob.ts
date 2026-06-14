import { z } from "zod";
import type { HttpClient } from "@weather/shared";

const CLOB_BASE = "https://clob.polymarket.com";

const LevelSchema = z.object({
  price: z.union([z.string(), z.number()]).transform(Number),
  size: z.union([z.string(), z.number()]).transform(Number),
});

export const BookSchema = z
  .object({
    market: z.string().optional(),
    asset_id: z.string().optional(),
    bids: z.array(LevelSchema).default([]),
    asks: z.array(LevelSchema).default([]),
  })
  .passthrough();

export type Book = z.infer<typeof BookSchema>;

const PriceHistoryPoint = z.object({
  t: z.number(), // unix seconds
  p: z.number(), // price
});

export const PriceHistorySchema = z.object({
  history: z.array(PriceHistoryPoint).default([]),
});

export type PriceHistoryInterval = "1m" | "1h" | "6h" | "1d" | "1w" | "max";

export class ClobClient {
  constructor(private readonly http: HttpClient) {}

  async getBook(tokenId: string): Promise<Book> {
    const raw = await this.http.getJson<unknown>(
      `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`,
    );
    return BookSchema.parse(raw);
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const raw = await this.http.getJson<{ mid?: string | number }>(
      `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
    );
    const n = Number(raw.mid);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Historical prices for a CLOB token. Coarse (>=12h) for resolved markets — used for
   * backfill seeding only; live high-frequency data comes from our own snapshots.
   */
  async getPriceHistory(
    tokenId: string,
    interval: PriceHistoryInterval = "max",
    fidelityMinutes?: number,
  ): Promise<{ t: Date; price: number }[]> {
    const qs = new URLSearchParams({ market: tokenId, interval });
    if (fidelityMinutes) qs.set("fidelity", String(fidelityMinutes));
    const raw = await this.http.getJson<unknown>(
      `${CLOB_BASE}/prices-history?${qs.toString()}`,
    );
    const parsed = PriceHistorySchema.parse(raw);
    return parsed.history.map((h) => ({ t: new Date(h.t * 1000), price: h.p }));
  }
}

/** Best bid / ask / midpoint / spread from a book. */
export function summariseBook(book: Book): {
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
} {
  const bestBid = book.bids.length
    ? Math.max(...book.bids.map((b) => b.price))
    : null;
  const bestAsk = book.asks.length
    ? Math.min(...book.asks.map((a) => a.price))
    : null;
  const midpoint =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return { bestBid, bestAsk, midpoint, spread };
}
