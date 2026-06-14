import { describe, expect, it } from "vitest";
import {
  analyzeKalshiMarket,
  fToC,
  isSettled,
  parseCityFromSeriesTitle,
  parseSettlement,
  parseSourceFromRules,
  parseStationFromRules,
  threshold,
} from "./temperature.js";
import { priceSummary } from "./kalshi.js";

const RULES =
  "If the highest temperature recorded in Central Park, New York for June 14, 2026 as reported by the National Weather Service's Climatological Report (Daily), is greater than 92°, then the market resolves to Yes.";

describe("parseCityFromSeriesTitle", () => {
  it("extracts and de-abbreviates the city", () => {
    expect(parseCityFromSeriesTitle("Highest temperature in NYC")).toBe("New York");
    expect(parseCityFromSeriesTitle("Highest temperature in Chicago")).toBe("Chicago");
  });
  it("returns null for unrelated titles", () => {
    expect(parseCityFromSeriesTitle("Will it rain?")).toBeNull();
  });
});

describe("rules parsing", () => {
  it("extracts the named station", () => {
    expect(parseStationFromRules(RULES)).toBe("Central Park, New York");
  });
  it("detects the NWS climatological-report source", () => {
    expect(parseSourceFromRules(RULES)).toBe("nws_cli");
  });
});

describe("analyzeKalshiMarket", () => {
  it("classifies a real NYC high-temp market", () => {
    const r = analyzeKalshiMarket(
      { ticker: "KXHIGHNY-26JUN14-T92", title: "Will the high temp in NYC be >92°?", rules_primary: RULES },
      "Highest temperature in NYC",
    );
    expect(r.isTemperature).toBe(true);
    expect(r.location).toBe("New York");
    expect(r.resolutionStation).toBe("Central Park, New York");
    expect(r.resolutionSource).toBe("nws_cli");
  });
});

describe("settlement parsing", () => {
  // Real finalized KXHIGHNY market shape (NYC high was 90°F on Jun 12 2026).
  const finalized = {
    ticker: "KXHIGHNY-26JUN12-T97",
    status: "finalized",
    result: "no",
    expiration_value: "90.00",
    settlement_ts: "2026-06-13T12:01:33.397299Z",
  };

  it("recognises settled/finalized status", () => {
    expect(isSettled(finalized)).toBe(true);
    expect(isSettled({ ticker: "x", status: "settled" })).toBe(true);
    expect(isSettled({ ticker: "x", status: "open" })).toBe(false);
  });

  it("extracts result, official value, and settlement time", () => {
    const s = parseSettlement(finalized);
    expect(s.result).toBe("no");
    expect(s.settledValueF).toBe(90);
    expect(s.settledAt?.toISOString()).toBe("2026-06-13T12:01:33.397Z");
  });

  it("returns null value when expiration_value is missing or empty", () => {
    expect(parseSettlement({ ticker: "x", status: "settled", result: "yes" }).settledValueF).toBeNull();
    expect(parseSettlement({ ticker: "x", expiration_value: "" }).settledValueF).toBeNull();
  });

  it("converts Fahrenheit settlement values to Celsius", () => {
    expect(fToC(32)).toBeCloseTo(0);
    expect(fToC(90)).toBeCloseTo(32.222, 2);
  });
});

describe("threshold + priceSummary", () => {
  it("reads the threshold subtitle", () => {
    expect(threshold({ ticker: "x", yes_sub_title: "93° or above" })).toBe("93° or above");
  });
  it("normalises dollar price fields and complements", () => {
    const s = priceSummary({
      ticker: "x",
      yes_bid_dollars: "0.02",
      yes_ask_dollars: "0.04",
      last_price_dollars: "0.02",
      volume_fp: "645",
    });
    expect(s.bestBid).toBeCloseTo(0.02);
    expect(s.bestAsk).toBeCloseTo(0.04);
    expect(s.midpoint).toBeCloseTo(0.03);
    expect(s.yesPrice).toBeCloseTo(0.03); // prefers live book midpoint
    expect(s.noPrice).toBeCloseTo(0.97);
    expect(s.volume).toBe(645);
  });
});
