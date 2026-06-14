import { z } from "zod";
import { Repo, getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";

loadRootEnv();

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const log = createLogger("backfill-kalshi");

/**
 * Best-effort price-history seed from Kalshi candlesticks for each temperature market.
 * Candlestick shape varies; parsing is defensive and skips anything it can't read.
 */
const CandlesticksSchema = z.object({
  candlesticks: z
    .array(
      z.object({
        end_period_ts: z.number().optional(),
        ts: z.number().optional(),
        price: z
          .object({ close: z.number().nullable().optional(), mean: z.number().nullable().optional() })
          .optional(),
        yes_ask: z.object({ close: z.number().nullable().optional() }).optional(),
      }),
    )
    .default([]),
});

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  const repo = new Repo(db);
  const http = new HttpClient(log, { minIntervalMs: 300 });

  const runId = await repo.startRun("backfill:kalshi", "candlesticks");
  let total = 0;
  try {
    const markets = (await repo.temperatureMarkets()).filter((m) => m.venue === "kalshi");
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - 30 * 24 * 3600;
    for (const m of markets) {
      const seriesTicker = (m.raw as { series_ticker?: string } | null)?.series_ticker;
      if (!seriesTicker) continue;
      const qs = new URLSearchParams({
        start_ts: String(startTs),
        end_ts: String(endTs),
        period_interval: "60",
      });
      const url = `${KALSHI_BASE}/series/${seriesTicker}/markets/${m.marketId}/candlesticks?${qs.toString()}`;
      try {
        const parsed = CandlesticksSchema.parse(await http.getJson<unknown>(url));
        const rows = parsed.candlesticks
          .map((c) => {
            const tsSec = c.end_period_ts ?? c.ts;
            const priceCents = c.price?.close ?? c.price?.mean ?? c.yes_ask?.close ?? null;
            if (tsSec == null || priceCents == null) return null;
            return { tokenId: m.marketId, t: new Date(tsSec * 1000), price: priceCents / 100 };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        await repo.insertPriceHistory(rows);
        total += rows.length;
      } catch (err) {
        log.warn({ ticker: m.marketId, err: (err as Error).message }, "candlesticks fetch failed");
      }
    }
    await repo.finishRun(runId, "ok", total);
    log.info({ total }, "kalshi backfill complete");
  } catch (err) {
    await repo.finishRun(runId, "error", total, { message: (err as Error).message });
    throw err;
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  log.error(err, "fatal");
  process.exit(1);
});
