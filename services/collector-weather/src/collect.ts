import { Repo, type Database } from "@weather/db";
import {
  checkNotFuture,
  checkTemperaturePlausible,
  type Logger,
  type HttpClient,
} from "@weather/shared";
import { NwsClient } from "./nws.js";
import { OpenMeteoClient, type GeoResult } from "./openmeteo.js";
import { STATION_COORD_OVERRIDES } from "./station-overrides.js";

/**
 * Phase 1 weather collection. For every CITY referenced by a temperature market we geocode
 * the city (Open-Meteo geocoding), then collect forecasts (each fetch is a new append-only
 * revision) and observations. Open-Meteo covers all cities globally; NWS adds US coverage.
 * Cities that fail to geocode are recorded as data-quality gaps rather than dropped.
 */
export class WeatherCollector {
  private readonly repo: Repo;
  private readonly nws: NwsClient;
  private readonly openMeteo: OpenMeteoClient;
  private readonly geoCache = new Map<string, GeoResult | null>();

  constructor(
    db: Database,
    http: HttpClient,
    private readonly log: Logger,
  ) {
    this.repo = new Repo(db);
    this.nws = new NwsClient(http);
    this.openMeteo = new OpenMeteoClient(http);
  }

  /** Geocode (cached) every temperature-market city; returns resolved + gap lists. */
  private async resolveCities(): Promise<{
    resolved: { city: string; station: string | null; geo: GeoResult }[];
    gaps: string[];
  }> {
    const locations = await this.repo.temperatureLocations();
    const resolved: { city: string; station: string | null; geo: GeoResult }[] = [];
    const gaps: string[] = [];
    for (const { location, resolutionStation } of locations) {
      // A curated override pins cities whose resolution station differs from the geocoded
      // centroid (e.g. LA → LAX); when present it replaces geocoding entirely.
      let geo: GeoResult | null | undefined = STATION_COORD_OVERRIDES[location];
      if (geo === undefined) {
        geo = this.geoCache.get(location);
        if (geo === undefined) {
          geo = await this.openMeteo.geocode(location).catch(() => null);
          this.geoCache.set(location, geo);
        }
      }
      if (geo) resolved.push({ city: location, station: resolutionStation, geo });
      else gaps.push(location);
    }
    return { resolved, gaps };
  }

  /** Stable station id for a city (prefer the market's named station, else a city slug). */
  private stationId(city: string, station: string | null): string {
    return station ?? `city:${city.toLowerCase().replace(/\s+/g, "-")}`;
  }

  async collectForecasts(): Promise<void> {
    const runId = await this.repo.startRun("weather", "forecasts");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const { resolved, gaps } = await this.resolveCities();
      for (const g of gaps) {
        checks.push({
          subject: g,
          checkName: "city_geocoded",
          passed: false,
          details: "could not geocode temperature-market city",
        });
      }

      for (const { city, station, geo } of resolved) {
        const stationId = this.stationId(city, station);
        const isUs = geo.countryCode === "US";
        await this.repo.upsertStation({
          stationId,
          name: station ?? city,
          lat: geo.lat,
          lon: geo.lon,
          source: isUs ? "nws" : "open-meteo",
        });

        // Open-Meteo (all cities)
        try {
          const { rows, raw } = await this.openMeteo.getForecast(geo.lat, geo.lon);
          for (const r of rows) {
            await this.repo.insertForecast({
              stationId,
              location: city,
              source: "open-meteo",
              targetDate: r.targetDate,
              forecastHighC: r.highC,
              forecastLowC: r.lowC,
              raw: raw as object,
            });
            checks.push({
              subject: stationId,
              ...checkTemperaturePlausible("forecast_high_plausible", r.highC),
            });
            count++;
          }
        } catch (err) {
          this.log.warn(
            { city, err: (err as Error).message },
            "open-meteo forecast failed",
          );
        }

        // NWS (US cities only)
        if (isUs) {
          try {
            const rows = await this.nws.getForecast(geo.lat, geo.lon);
            for (const r of rows) {
              await this.repo.insertForecast({
                stationId,
                location: city,
                source: "nws",
                targetDate: r.targetDate,
                forecastHighC: r.highC,
                forecastLowC: r.lowC,
                forecastRunAt: r.runAt,
                raw: r.raw as object,
              });
              count++;
            }
          } catch (err) {
            this.log.warn(
              { city, err: (err as Error).message },
              "nws forecast failed",
            );
          }
        }
      }

      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info({ count, cities: resolved.length, gaps: gaps.length }, "forecasts collected");
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, {
        message: (err as Error).message,
      });
      throw err;
    }
  }

  async collectObservations(): Promise<void> {
    const runId = await this.repo.startRun("weather", "observations");
    let count = 0;
    const checks: Parameters<Repo["recordChecks"]>[1] = [];
    try {
      const { resolved } = await this.resolveCities();
      for (const { city, station, geo } of resolved) {
        const stationId = this.stationId(city, station);
        const isUs = geo.countryCode === "US";

        // Open-Meteo current temperature (global proxy for hourly observation)
        try {
          const obs = await this.openMeteo.getCurrent(geo.lat, geo.lon);
          await this.repo.insertObservation({
            stationId,
            source: "open-meteo",
            observedAt: obs.observedAt,
            tempC: obs.tempC,
            isHourly: true,
            raw: obs.raw as object,
          });
          checks.push({
            subject: stationId,
            ...checkTemperaturePlausible("obs_temp_plausible", obs.tempC),
          });
          checks.push({
            subject: stationId,
            ...checkNotFuture("obs_not_future", obs.observedAt),
          });
          count++;
        } catch (err) {
          this.log.warn({ city, err: (err as Error).message }, "open-meteo obs failed");
        }

        // NWS latest observation (US only) — closer to the resolution source
        if (isUs) {
          try {
            const nwsObs = await this.nws.getLatestObservation(geo.lat, geo.lon);
            if (nwsObs) {
              await this.repo.insertObservation({
                stationId,
                source: "nws",
                observedAt: nwsObs.observedAt,
                tempC: nwsObs.tempC,
                isHourly: true,
                raw: nwsObs.raw as object,
              });
              count++;
            }
          } catch (err) {
            this.log.warn({ city, err: (err as Error).message }, "nws obs failed");
          }
        }
      }
      await this.repo.recordChecks(runId, checks);
      await this.repo.finishRun(runId, "ok", count);
      this.log.info({ count }, "observations collected");
    } catch (err) {
      await this.repo.finishRun(runId, "error", count, {
        message: (err as Error).message,
      });
      throw err;
    }
  }
}
