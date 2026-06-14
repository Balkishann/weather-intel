import type { KalshiMarket } from "./kalshi.js";

/**
 * Parsing for Kalshi daily temperature markets. Verified against live rules text, e.g.:
 * "If the highest temperature recorded in Central Park, New York for June 14, 2026 as
 *  reported by the National Weather Service's Climatological Report (Daily), is greater
 *  than 92°, then the market resolves to Yes."
 *
 * The series title ("Highest temperature in NYC") gives a clean, geocodable city; the rules
 * give the named station and confirm the NWS-CLI resolution source.
 */

// Abbreviations Kalshi uses in series titles that geocoders won't resolve well.
const CITY_ALIASES: Record<string, string> = {
  nyc: "New York",
  la: "Los Angeles",
  dc: "Washington",
  philly: "Philadelphia",
};

export interface KalshiResolutionInfo {
  isTemperature: boolean;
  location: string | null; // geocodable city
  resolutionStation: string | null; // named place from rules, e.g. "Central Park, New York"
  resolutionSource: string | null; // "nws_cli" | null
}

export function parseCityFromSeriesTitle(title: string | undefined): string | null {
  if (!title) return null;
  const m = title.match(/temp(?:erature)? in\s+(.+?)\s*$/i);
  if (!m) return null;
  const raw = m[1]!.trim().replace(/[?.]+$/, "");
  return CITY_ALIASES[raw.toLowerCase()] ?? raw;
}

export function parseStationFromRules(rules: string | undefined): string | null {
  if (!rules) return null;
  const m = rules.match(/recorded (?:in|at)\s+(.+?)\s+for\b/i);
  return m ? m[1]!.trim() : null;
}

export function parseSourceFromRules(rules: string | undefined): string | null {
  if (!rules) return null;
  if (/climatolog|national weather service|\bnws\b/i.test(rules)) return "nws_cli";
  return null;
}

export function threshold(m: KalshiMarket): string | null {
  return m.yes_sub_title ?? m.subtitle ?? null;
}

export interface KalshiSettlement {
  result: string | null; // "yes" | "no" | "" (void)
  settledValueF: number | null; // official measured value Kalshi settled on, °F
  settledAt: Date | null; // when Kalshi finalized
}

/** A market is settled once Kalshi reports status "settled"/"finalized". */
export function isSettled(m: KalshiMarket): boolean {
  return m.status === "settled" || m.status === "finalized";
}

/** Pull the settlement outcome + official value from a finalized Kalshi temperature market. */
export function parseSettlement(m: KalshiMarket): KalshiSettlement {
  const v =
    m.expiration_value === undefined || m.expiration_value === null || m.expiration_value === ""
      ? null
      : Number(m.expiration_value);
  return {
    result: m.result ?? null,
    settledValueF: v !== null && Number.isFinite(v) ? v : null,
    settledAt: m.settlement_ts ? new Date(m.settlement_ts) : null,
  };
}

/** Fahrenheit → Celsius (settled temps arrive in °F; rest of the schema is °C). */
export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

export function analyzeKalshiMarket(
  m: KalshiMarket,
  seriesTitle: string | undefined,
): KalshiResolutionInfo {
  const text = `${seriesTitle ?? ""} ${m.title ?? ""} ${m.rules_primary ?? ""}`;
  const station = parseStationFromRules(m.rules_primary);
  return {
    isTemperature: /temperature|high temp|low temp/i.test(text),
    // Fall back to the station place (e.g. "Phoenix") when the title isn't parseable.
    location:
      parseCityFromSeriesTitle(seriesTitle) ?? parseCityFromSeriesTitle(m.title) ?? station,
    resolutionStation: station,
    resolutionSource: parseSourceFromRules(m.rules_primary),
  };
}
