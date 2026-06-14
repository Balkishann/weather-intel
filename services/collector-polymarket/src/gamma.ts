import { z } from "zod";
import type { HttpClient } from "@weather/shared";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

/**
 * Gamma market shape. Polymarket returns many fields as strings (prices, volume) and
 * `outcomePrices` / `clobTokenIds` as JSON-encoded strings. We keep the raw payload too.
 */
export const GammaMarketSchema = z
  .object({
    id: z.string().or(z.number()).transform(String),
    conditionId: z.string().optional(),
    questionID: z.string().optional(),
    question: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    endDate: z.string().optional(),
    volume: z.union([z.string(), z.number()]).optional(),
    liquidity: z.union([z.string(), z.number()]).optional(),
    outcomePrices: z.string().optional(), // JSON-encoded array, e.g. '["0.51","0.49"]'
    outcomes: z.string().optional(), // JSON-encoded array, e.g. '["Yes","No"]'
    clobTokenIds: z.string().optional(), // JSON-encoded array of token ids
  })
  .passthrough();

export type GammaMarket = z.infer<typeof GammaMarketSchema>;

/** A weather event groups multiple threshold markets for one city + date. */
export const GammaEventSchema = z
  .object({
    id: z.string().or(z.number()).transform(String),
    title: z.string().optional(),
    slug: z.string().optional(),
    closed: z.boolean().optional(),
    markets: z.array(GammaMarketSchema).default([]),
  })
  .passthrough();

export type GammaEvent = z.infer<typeof GammaEventSchema>;

export interface ListMarketsParams {
  active?: boolean;
  closed?: boolean;
  tag?: string;
  limit?: number;
  offset?: number;
  order?: string;
}

export class GammaClient {
  constructor(private readonly http: HttpClient) {}

  /** Page through /markets. Returns parsed markets plus the raw objects. */
  async listMarkets(
    params: ListMarketsParams = {},
  ): Promise<{ market: GammaMarket; raw: unknown }[]> {
    const qs = new URLSearchParams();
    if (params.active !== undefined) qs.set("active", String(params.active));
    if (params.closed !== undefined) qs.set("closed", String(params.closed));
    if (params.tag) qs.set("tag", params.tag);
    qs.set("limit", String(params.limit ?? 100));
    qs.set("offset", String(params.offset ?? 0));
    if (params.order) qs.set("order", params.order);

    const data = await this.http.getJson<unknown[]>(
      `${GAMMA_BASE}/markets?${qs.toString()}`,
    );
    const out: { market: GammaMarket; raw: unknown }[] = [];
    for (const raw of data) {
      const parsed = GammaMarketSchema.safeParse(raw);
      if (parsed.success) out.push({ market: parsed.data, raw });
    }
    return out;
  }

  /** Full market detail (includes clobTokenIds + outcomePrices, which events omit). */
  async getMarket(id: string): Promise<{ market: GammaMarket; raw: unknown } | null> {
    const raw = await this.http.getJson<unknown>(
      `${GAMMA_BASE}/markets/${encodeURIComponent(id)}`,
    );
    const parsed = GammaMarketSchema.safeParse(raw);
    return parsed.success ? { market: parsed.data, raw } : null;
  }

  /** Page through open events for a tag (e.g. "weather"). */
  async listEventsByTag(
    tagSlug: string,
    pageSize = 100,
  ): Promise<GammaEvent[]> {
    const out: GammaEvent[] = [];
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        tag_slug: tagSlug,
        closed: "false",
        limit: String(pageSize),
        offset: String(offset),
      });
      const data = await this.http.getJson<unknown[]>(
        `${GAMMA_BASE}/events?${qs.toString()}`,
      );
      for (const raw of data) {
        const parsed = GammaEventSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      }
      if (data.length < pageSize) return out;
      offset += pageSize;
    }
  }

  /** Convenience: iterate all active markets via offset paging. */
  async *iterateActiveMarkets(
    pageSize = 100,
  ): AsyncGenerator<{ market: GammaMarket; raw: unknown }> {
    let offset = 0;
    for (;;) {
      const page = await this.listMarkets({
        active: true,
        closed: false,
        limit: pageSize,
        offset,
      });
      if (page.length === 0) return;
      for (const m of page) yield m;
      if (page.length < pageSize) return;
      offset += pageSize;
    }
  }
}

/** Decode Gamma's JSON-encoded string arrays defensively. */
export function decodeJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
