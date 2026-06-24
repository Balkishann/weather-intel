import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

/**
 * Load the nearest `.env` by walking up from the current working directory. Services are run
 * via `pnpm --filter` (cwd = the package dir), so a plain `dotenv/config` would miss the
 * repo-root `.env`. Call this once at the top of an entrypoint, before `loadConfig`.
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenvConfig(); // fall back to default behaviour
}

/**
 * Centralised, validated configuration. Reads from process.env (load .env via dotenv in
 * the service entrypoint before importing this). Fails fast with a clear message if a
 * required variable is missing or malformed.
 */
const ConfigSchema = z.object({
  databaseUrl: z.string().min(1, "DATABASE_URL is required"),
  redisUrl: z.string().default("redis://localhost:6379"),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  nwsUserAgent: z
    .string()
    .min(1)
    .default("kalshi-weather-intel/0.1 (contact@example.com)"),
  noaaCdoToken: z.string().optional(),
  cron: z.object({
    markets: z.string().default("*/10 * * * *"),
    prices: z.string().default("*/2 * * * *"),
    resolutions: z.string().default("30 * * * *"), // hourly; markets settle daily ~AM ET
    weatherForecast: z.string().default("0 * * * *"),
    weatherObs: z.string().default("15 * * * *"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    logLevel: env.LOG_LEVEL,
    nwsUserAgent: env.NWS_USER_AGENT,
    noaaCdoToken: env.NOAA_CDO_TOKEN,
    cron: {
      markets: env.CRON_MARKETS,
      prices: env.CRON_PRICES,
      resolutions: env.CRON_RESOLUTIONS,
      weatherForecast: env.CRON_WEATHER_FORECAST,
      weatherObs: env.CRON_WEATHER_OBS,
    },
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
