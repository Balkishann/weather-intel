import type { GeoResult } from "./openmeteo.js";

/**
 * Curated coordinate overrides for cities whose Kalshi resolution station is NOT the city
 * centroid the Open-Meteo geocoder returns. Without these, the weather proxy samples a
 * different microclimate than the official NWS-CLI station, biasing every comparison.
 *
 * Verified case (2026-06-20 reconciliation gate, see progress.md): Kalshi `KXHIGHLAX`
 * resolves on "Los Angeles Airport, CA" = LAX — a coastal, marine-layer-cooled station whose
 * June highs run ~21–22 °C. Geocoding the string "Los Angeles" returns the downtown/inland
 * centroid (~27–28 °C), so the proxy read the official value +5–6 °C hot on all 7 LA days.
 *
 * Keyed by `markets.location` (the same value `resolveCities` iterates). When present, the
 * override is used INSTEAD of geocoding, so it covers every resolution-station name variant
 * for that city in one place.
 *
 * Forward-only: this changes coordinates for forecasts/observations collected from now on.
 * Historical rows keep their old (centroid) coords — the schema is append-only — so the
 * latency analysis should exclude an overridden city's pre-override days (or treat the
 * change date as a discontinuity).
 */
export const STATION_COORD_OVERRIDES: Record<string, GeoResult> = {
  // KLAX ASOS reference point — the station the NWS Climatological Report (Daily) reports for
  // Los Angeles, and what Kalshi settles KXHIGHLAX on.
  "Los Angeles": {
    name: "Los Angeles Intl Airport (LAX)",
    lat: 33.9381,
    lon: -118.3889,
    countryCode: "US",
  },
};
