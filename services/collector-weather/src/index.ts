import cron from "node-cron";
import { getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";
import { WeatherCollector } from "./collect.js";

loadRootEnv();
const log = createLogger("collector-weather");

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  // NWS requires a descriptive User-Agent; be polite with a longer min interval.
  const http = new HttpClient(log, {
    minIntervalMs: 600,
    maxRetries: 4,
    defaultHeaders: { "User-Agent": config.nwsUserAgent, Accept: "application/geo+json" },
  });
  const collector = new WeatherCollector(db, http, log);

  if (process.argv.includes("--once")) {
    log.info("running one weather collection cycle");
    await collector.collectForecasts();
    await collector.collectObservations();
    await closeDb();
    return;
  }

  log.info(
    { forecast: config.cron.weatherForecast, obs: config.cron.weatherObs },
    "scheduling weather collectors",
  );

  cron.schedule(config.cron.weatherForecast, () => {
    collector.collectForecasts().catch((e) => log.error(e, "forecast run failed"));
  });
  cron.schedule(config.cron.weatherObs, () => {
    collector.collectObservations().catch((e) => log.error(e, "observation run failed"));
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
