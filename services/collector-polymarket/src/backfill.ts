import { Repo, getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";
import { ClobClient } from "./clob.js";

loadRootEnv();

/**
 * Seed historical CLOB prices for every temperature market's tokens via /prices-history.
 * Coarse for resolved markets (>=12h) — this is a one-time seed, not the live source.
 */
const log = createLogger("backfill-prices");

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  const repo = new Repo(db);
  const http = new HttpClient(log, { minIntervalMs: 300 });
  const clob = new ClobClient(http);

  const runId = await repo.startRun("backfill:prices", "prices-history");
  let total = 0;
  try {
    const temps = await repo.temperatureMarkets();
    log.info({ markets: temps.length }, "backfilling price history");
    for (const m of temps) {
      const tokenIds = (m.clobTokenIds as string[] | null) ?? [];
      for (const tokenId of tokenIds) {
        try {
          const points = await clob.getPriceHistory(tokenId, "max");
          await repo.insertPriceHistory(
            points.map((p) => ({ tokenId, t: p.t, price: p.price })),
          );
          total += points.length;
        } catch (err) {
          log.warn(
            { tokenId, err: (err as Error).message },
            "price history fetch failed",
          );
        }
      }
    }
    await repo.finishRun(runId, "ok", total);
    log.info({ total }, "backfill complete");
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
