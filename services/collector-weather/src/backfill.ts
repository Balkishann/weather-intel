import { Repo, getDb, closeDb } from "@weather/db";
import { HttpClient, createLogger, loadConfig, loadRootEnv } from "@weather/shared";
import { OpenMeteoClient } from "./openmeteo.js";
import { STATION_COORD_OVERRIDES } from "./station-overrides.js";

loadRootEnv();

/**
 * Seed historical daily observations from Open-Meteo's archive for every temperature
 * market's resolution station. Usage: tsx src/backfill.ts [startDate] [endDate]
 * Dates are ISO (YYYY-MM-DD); defaults to the last 90 days.
 */
const log = createLogger("backfill-weather");

async function main() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  const repo = new Repo(db);
  const http = new HttpClient(log, { minIntervalMs: 400 });
  const om = new OpenMeteoClient(http);

  const end = process.argv[3] ?? isoDaysAgo(1);
  const start = process.argv[2] ?? isoDaysAgo(90);

  const runId = await repo.startRun("backfill:weather", "open-meteo-archive");
  let count = 0;
  try {
    const locations = await repo.temperatureLocations();
    for (const { location, resolutionStation } of locations) {
      const geo =
        STATION_COORD_OVERRIDES[location] ?? (await om.geocode(location).catch(() => null));
      if (!geo) {
        log.warn({ location }, "could not geocode, skipping");
        continue;
      }
      const stationId =
        resolutionStation ?? `city:${location.toLowerCase().replace(/\s+/g, "-")}`;
      const { rows } = await om.getArchive(geo.lat, geo.lon, start, end);
      for (const r of rows) {
        await repo.insertObservation({
          stationId,
          source: "open-meteo",
          observedAt: r.targetDate,
          tempC: r.highC,
          isHourly: false,
          dailyMaxTempC: r.highC,
        });
        count++;
      }
    }
    await repo.finishRun(runId, "ok", count);
    log.info({ count, start, end }, "weather backfill complete");
  } catch (err) {
    await repo.finishRun(runId, "error", count, { message: (err as Error).message });
    throw err;
  } finally {
    await closeDb();
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  log.error(err, "fatal");
  process.exit(1);
});
