import cron from "node-cron";
import { getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";
import { PolymarketCollector } from "./collect.js";

loadRootEnv();
const log = createLogger("collector-polymarket");

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  const http = new HttpClient(log, { minIntervalMs: 250, maxRetries: 4 });
  const collector = new PolymarketCollector(db, http, log);

  const runOnce = process.argv.includes("--once");

  if (runOnce) {
    log.info("running one collection cycle (markets then prices)");
    await collector.collectMarkets();
    await collector.collectPrices();
    await closeDb();
    return;
  }

  log.info(
    { markets: config.cron.markets, prices: config.cron.prices },
    "scheduling Polymarket collectors",
  );

  // Discover markets first so the prices task has temperature markets to poll.
  await collector.collectMarkets().catch((e) => log.error(e, "initial markets run failed"));

  cron.schedule(config.cron.markets, () => {
    collector.collectMarkets().catch((e) => log.error(e, "markets run failed"));
  });
  cron.schedule(config.cron.prices, () => {
    collector.collectPrices().catch((e) => log.error(e, "prices run failed"));
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info("shutting down");
      void closeDb().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  log.error(err, "fatal");
  process.exit(1);
});
