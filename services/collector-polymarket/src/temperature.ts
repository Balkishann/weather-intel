import type { GammaMarket } from "./gamma.js";

/**
 * Parsing for Polymarket daily high-temperature markets. Their real structure (verified
 * against the live API) is:
 *   - Event title: "Highest temperature in <City> on <Month Day>?"
 *   - 11 threshold markets per event, e.g. groupItemTitle = "19°C or below".
 *   - Description: "...recorded at the <Airport> Station in degrees Celsius on <date>.
 *     The resolution source ... will be information from Wunderground ... <url>".
 *
 * These heuristics are conservative and unit-tested; unknowns stay null rather than guessed,
 * so coverage gaps surface in the Phase 1 report instead of corrupting the dataset.
 */

const TEMP_KEYWORDS =
  /\b(highest temperature|high temp|temperature|hottest|degrees?|°\s?[fc]\b|fahrenheit|celsius)\b/i;

export interface ResolutionInfo {
  isTemperature: boolean;
  location: string | null; // city, e.g. "London"
  resolutionStation: string | null; // named station, e.g. "London Heathrow Airport"
  resolutionSource: string | null; // "weather_underground" | "nws" | null
  resolutionUrl: string | null; // wunderground history URL if present
}

/** "Highest temperature in <City> on <date>?" -> "<City>". */
export function parseLocationFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const m = title.match(/temperature in\s+(.+?)\s+on\b/i);
  return m ? m[1]!.trim() : null;
}

/** Pull the named "... Airport Station" / "... Station" from the description. */
export function parseStationFromDescription(desc: string | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/recorded at the\s+(.+?Station)\b/i);
  if (m) return m[1]!.trim();
  const code = desc.match(/\b[KE][A-Z]{3}\b/);
  return code ? code[0] : null;
}

export function parseResolutionUrl(desc: string | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/https?:\/\/\S*wunderground\.com\/\S+/i);
  return m ? m[0].replace(/[).,]+$/, "") : null;
}

export function parseResolutionSource(text: string): string | null {
  if (/weather\s*underground|wunderground/i.test(text)) return "weather_underground";
  if (/\bnws\b|national weather service|climate report/i.test(text)) return "nws";
  return null;
}

/** Analyse a single market plus (optionally) its event title for full context. */
export function analyzeMarket(
  m: GammaMarket,
  eventTitle?: string,
): ResolutionInfo {
  const text = `${eventTitle ?? ""} ${m.question ?? ""} ${m.slug ?? ""} ${m.description ?? ""}`;
  return {
    isTemperature: TEMP_KEYWORDS.test(text),
    location: parseLocationFromTitle(eventTitle ?? m.question),
    resolutionStation: parseStationFromDescription(m.description),
    resolutionSource: parseResolutionSource(text),
    resolutionUrl: parseResolutionUrl(m.description),
  };
}
