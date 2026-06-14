import "dotenv/config";
import { HttpClient, createLogger } from "@weather/shared";
import { GammaClient, decodeJsonArray } from "../services/collector-polymarket/src/gamma.js";
import { ClobClient, summariseBook } from "../services/collector-polymarket/src/clob.js";
import { analyzeMarket } from "../services/collector-polymarket/src/temperature.js";
import { NwsClient } from "../services/collector-weather/src/nws.js";
import { OpenMeteoClient } from "../services/collector-weather/src/openmeteo.js";
import { KalshiClient, priceSummary } from "../services/collector-kalshi/src/kalshi.js";
import { analyzeKalshiMarket, threshold } from "../services/collector-kalshi/src/temperature.js";

/**
 * DB-free smoke test: exercises the REAL collector code paths (weather-event discovery,
 * per-market detail, order book, geocoding, forecasts, observations) against LIVE endpoints.
 * Verifies the integration + zod layer without needing Postgres.
 */
const log = createLogger("smoke");

async function main() {
  const http = new HttpClient(log, {
    minIntervalMs: 400,
    defaultHeaders: {
      "User-Agent": process.env.NWS_USER_AGENT ?? "weather-intel-smoke/0.1",
      Accept: "application/geo+json",
    },
  });
  const gamma = new GammaClient(http);
  const clob = new ClobClient(http);
  const nws = new NwsClient(http);
  const om = new OpenMeteoClient(http);

  console.log("\n=== Discover weather events ===");
  const events = await gamma.listEventsByTag("weather");
  const tempEvents = events.filter((e) => /highest temperature|temperature/i.test(e.title ?? ""));
  console.log(`weather events: ${events.length}, temperature events: ${tempEvents.length}`);

  const event = tempEvents[0];
  if (!event) {
    console.log("no temperature events open right now");
    return;
  }
  console.log(`sample event: "${event.title}" with ${event.markets.length} markets`);

  console.log("\n=== Market detail + classification ===");
  const lite = event.markets[0]!;
  const detail = await gamma.getMarket(lite.id);
  const market = detail?.market ?? lite;
  const info = analyzeMarket(market, event.title);
  const tokenIds = decodeJsonArray(market.clobTokenIds);
  console.log({
    threshold: (market as { groupItemTitle?: string }).groupItemTitle,
    location: info.location,
    station: info.resolutionStation,
    source: info.resolutionSource,
    tokens: tokenIds.length,
    outcomePrices: market.outcomePrices,
  });

  console.log("\n=== Order book (YES token) ===");
  if (tokenIds[0]) {
    try {
      console.log(summariseBook(await clob.getBook(tokenIds[0])));
    } catch (e) {
      console.log("book fetch failed:", (e as Error).message);
    }
  }

  console.log("\n=== Geocode + weather for the event city ===");
  const city = info.location ?? "London";
  const geo = await om.geocode(city);
  console.log("geocode:", geo);
  if (geo) {
    const fc = await om.getForecast(geo.lat, geo.lon, 3);
    console.log(`Open-Meteo daily rows: ${fc.rows.length}; first:`, fc.rows[0]);
    const cur = await om.getCurrent(geo.lat, geo.lon);
    console.log("Open-Meteo current:", { at: cur.observedAt, tempC: cur.tempC });
    if (geo.countryCode === "US") {
      const nfc = await nws.getForecast(geo.lat, geo.lon);
      console.log(`NWS daily periods: ${nfc.length}; first:`, nfc[0]);
    } else {
      console.log("non-US city -> Open-Meteo only (NWS skipped)");
    }
  }

  console.log("\n=== Kalshi: temperature series + market + book ===");
  const kalshi = new KalshiClient(http);
  const series = await kalshi.listTemperatureSeries();
  console.log(`temperature series: ${series.length}`);
  let ks = series[0];
  let kmarkets: Awaited<ReturnType<typeof kalshi.listOpenMarkets>> = [];
  for (const cand of series.slice(0, 10)) {
    const ms = await kalshi.listOpenMarkets(cand.ticker);
    if (ms.length) {
      ks = cand;
      kmarkets = ms;
      break;
    }
  }
  if (ks) {
    console.log(`open markets for ${ks.ticker} (${ks.title}): ${kmarkets.length}`);
    const km = kmarkets[0];
    if (km) {
      const info = analyzeKalshiMarket(km, ks.title);
      console.log("classify:", { ticker: km.ticker, threshold: threshold(km), ...info });
      const fresh = await kalshi.getMarket(km.ticker);
      console.log("price:", priceSummary(fresh ?? km));
      const book = await kalshi.getOrderbook(km.ticker, 3);
      console.log("orderbook yes/no levels:", book.yes.length, book.no.length);
    }
  }

  console.log("\nSMOKE OK\n");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
