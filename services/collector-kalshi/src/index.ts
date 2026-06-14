import cron from "node-cron";
import { getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";
import { KalshiCollector } from "./collect.js";

loadRootEnv();
const log = createLogger("collector-kalshi");

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  const http = new HttpClient(log, { minIntervalMs: 120, maxRetries: 4 });
  const collector = new KalshiCollector(db, http, log);

  if (process.argv.includes("--once")) {
    log.info("running one kalshi collection cycle (markets, prices, resolutions)");
    await collector.collectMarkets();
    await collector.collectPrices();
    await collector.collectResolutions();
    await closeDb();
    return;
  }

  log.info(
    { markets: config.cron.markets, prices: config.cron.prices, resolutions: config.cron.resolutions },
    "scheduling Kalshi collectors",
  );

  await collector.collectMarkets().catch((e) => log.error(e, "initial markets run failed"));

  cron.schedule(config.cron.markets, () => {
    collector.collectMarkets().catch((e) => log.error(e, "markets run failed"));
  });
  cron.schedule(config.cron.prices, () => {
    collector.collectPrices().catch((e) => log.error(e, "prices run failed"));
  });
  cron.schedule(config.cron.resolutions, () => {
    collector.collectResolutions().catch((e) => log.error(e, "resolutions run failed"));
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
