import { z } from "zod";
import type { HttpClient } from "@weather/shared";

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const GEOCODE_BASE = "https://geocoding-api.open-meteo.com/v1/search";

const DailySchema = z.object({
  time: z.array(z.string()),
  temperature_2m_max: z.array(z.number().nullable()).optional(),
  temperature_2m_min: z.array(z.number().nullable()).optional(),
});

const ForecastResponse = z.object({
  generationtime_ms: z.number().optional(),
  daily: DailySchema.optional(),
  current: z
    .object({ time: z.string(), temperature_2m: z.number().nullable() })
    .optional(),
});

const GeocodeResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country_code: z.string().optional(),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
});

export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
  countryCode: string | null;
}

export interface DailyTemp {
  targetDate: Date;
  highC: number | null;
  lowC: number | null;
}

/**
 * Open-Meteo is a best-effort, free upstream that rate-limits (429) some IP ranges (notably
 * cloud/datacenter IPs). Retrying a 429 with the default long backoff turns that into a
 * multi-minute stall per city, which previously blew the collector's whole timeout before
 * anything was written. For US Kalshi cities NWS is the primary proxy, so we let Open-Meteo
 * fail fast and simply skip it when it's throttled, rather than hang the run.
 */
const BEST_EFFORT = { maxRetries: 1, maxBackoffMs: 1500 } as const;

export class OpenMeteoClient {
  constructor(private readonly http: HttpClient) {}

  /** Daily max/min forecast (Celsius). Each repeated fetch becomes a new revision row. */
  async getForecast(
    lat: number,
    lon: number,
    days = 7,
  ): Promise<{ rows: DailyTemp[]; raw: unknown }> {
    const qs = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      daily: "temperature_2m_max,temperature_2m_min",
      timezone: "UTC",
      forecast_days: String(days),
    });
    const raw = await this.http.getJson<unknown>(`${FORECAST_BASE}?${qs.toString()}`, BEST_EFFORT);
    return { rows: toDaily(raw), raw };
  }

  /** Current temperature observation (used as an hourly observation proxy, global). */
  async getCurrent(
    lat: number,
    lon: number,
  ): Promise<{ observedAt: Date; tempC: number | null; raw: unknown }> {
    const qs = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m",
      timezone: "UTC",
    });
    const raw = await this.http.getJson<unknown>(`${FORECAST_BASE}?${qs.toString()}`, BEST_EFFORT);
    const parsed = ForecastResponse.parse(raw);
    return {
      observedAt: parsed.current ? new Date(`${parsed.current.time}Z`) : new Date(),
      tempC: parsed.current?.temperature_2m ?? null,
      raw,
    };
  }

  /** Resolve a city name to coordinates. Returns null if not found. */
  async geocode(name: string): Promise<GeoResult | null> {
    const qs = new URLSearchParams({ name, count: "1", language: "en", format: "json" });
    const raw = await this.http.getJson<unknown>(`${GEOCODE_BASE}?${qs.toString()}`, BEST_EFFORT);
    const r = GeocodeResponse.parse(raw).results?.[0];
    if (!r) return null;
    return {
      name: r.name,
      lat: r.latitude,
      lon: r.longitude,
      countryCode: r.country_code ?? null,
    };
  }

  /** Historical daily max/min for backfill seeding. */
  async getArchive(
    lat: number,
    lon: number,
    startDate: string,
    endDate: string,
  ): Promise<{ rows: DailyTemp[]; raw: unknown }> {
    const qs = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      start_date: startDate,
      end_date: endDate,
      daily: "temperature_2m_max,temperature_2m_min",
      timezone: "UTC",
    });
    const raw = await this.http.getJson<unknown>(`${ARCHIVE_BASE}?${qs.toString()}`);
    return { rows: toDaily(raw), raw };
  }
}

function toDaily(raw: unknown): DailyTemp[] {
  const parsed = ForecastResponse.parse(raw);
  const d = parsed.daily;
  if (!d) return [];
  return d.time.map((date, i) => ({
    targetDate: new Date(`${date}T00:00:00Z`),
    highC: d.temperature_2m_max?.[i] ?? null,
    lowC: d.temperature_2m_min?.[i] ?? null,
  }));
}
