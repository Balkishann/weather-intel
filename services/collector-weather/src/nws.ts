import { z } from "zod";
import { fahrenheitToCelsius, type HttpClient } from "@weather/shared";

const NWS_BASE = "https://api.weather.gov";

const PointsSchema = z.object({
  properties: z.object({
    gridId: z.string(),
    gridX: z.number(),
    gridY: z.number(),
    forecast: z.string(),
    observationStations: z.string(),
  }),
});

const ForecastSchema = z.object({
  properties: z.object({
    updateTime: z.string().optional(),
    periods: z.array(
      z.object({
        startTime: z.string(),
        isDaytime: z.boolean(),
        temperature: z.number(),
        temperatureUnit: z.string(), // "F"
        shortForecast: z.string().optional(),
      }),
    ),
  }),
});

const ObsSchema = z.object({
  properties: z.object({
    timestamp: z.string(),
    temperature: z.object({
      value: z.number().nullable(), // already Celsius
      unitCode: z.string().optional(),
    }),
  }),
});

export interface NwsDailyForecast {
  targetDate: Date;
  highC: number | null;
  lowC: number | null;
  runAt: Date | null;
  raw: unknown;
}

export class NwsClient {
  constructor(private readonly http: HttpClient) {}

  private async points(lat: number, lon: number) {
    const raw = await this.http.getJson<unknown>(
      `${NWS_BASE}/points/${lat},${lon}`,
    );
    return PointsSchema.parse(raw).properties;
  }

  /** Daily forecast: pair each daytime (high) period with the following night (low). */
  async getForecast(lat: number, lon: number): Promise<NwsDailyForecast[]> {
    const p = await this.points(lat, lon);
    const raw = await this.http.getJson<unknown>(p.forecast);
    const parsed = ForecastSchema.parse(raw);
    const runAt = parsed.properties.updateTime
      ? new Date(parsed.properties.updateTime)
      : null;

    const byDate = new Map<string, { high: number | null; low: number | null }>();
    for (const period of parsed.properties.periods) {
      const date = period.startTime.slice(0, 10);
      const c =
        period.temperatureUnit === "F"
          ? fahrenheitToCelsius(period.temperature)
          : period.temperature;
      const entry = byDate.get(date) ?? { high: null, low: null };
      if (period.isDaytime) entry.high = c;
      else entry.low = c;
      byDate.set(date, entry);
    }

    return [...byDate.entries()].map(([date, v]) => ({
      targetDate: new Date(`${date}T00:00:00Z`),
      highC: v.high,
      lowC: v.low,
      runAt,
      raw,
    }));
  }

  /** Latest observation from the nearest station to the point. */
  async getLatestObservation(
    lat: number,
    lon: number,
  ): Promise<{ observedAt: Date; tempC: number | null; raw: unknown } | null> {
    const p = await this.points(lat, lon);
    const stations = await this.http.getJson<{ features: { id: string }[] }>(
      p.observationStations,
    );
    const stationUrl = stations.features[0]?.id;
    if (!stationUrl) return null;
    const raw = await this.http.getJson<unknown>(`${stationUrl}/observations/latest`);
    const obs = ObsSchema.parse(raw).properties;
    return {
      observedAt: new Date(obs.timestamp),
      tempC: obs.temperature.value,
      raw,
    };
  }
}
