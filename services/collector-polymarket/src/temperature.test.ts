import { describe, expect, it } from "vitest";
import {
  analyzeMarket,
  parseLocationFromTitle,
  parseStationFromDescription,
  parseResolutionUrl,
  parseResolutionSource,
} from "./temperature.js";
import { decodeJsonArray } from "./gamma.js";

const LONDON_DESC =
  "This market will resolve to the temperature range that contains the highest temperature recorded at the London Heathrow Airport Station in degrees Celsius on 13 Jun '26. The resolution source for this market will be information from Wunderground ... available here: https://www.wunderground.com/history/daily/gb/london";

describe("parseLocationFromTitle", () => {
  it("extracts the city from a real event title", () => {
    expect(parseLocationFromTitle("Highest temperature in London on June 13?")).toBe("London");
    expect(parseLocationFromTitle("Highest temperature in Hong Kong on June 12?")).toBe(
      "Hong Kong",
    );
  });
  it("returns null for unrelated titles", () => {
    expect(parseLocationFromTitle("Will the Lakers win?")).toBeNull();
  });
});

describe("parseStationFromDescription", () => {
  it("extracts the named airport station", () => {
    expect(parseStationFromDescription(LONDON_DESC)).toBe("London Heathrow Airport Station");
  });
  it("falls back to a station code", () => {
    expect(parseStationFromDescription("settles on station KORD observations")).toBe("KORD");
  });
});

describe("parseResolutionUrl / source", () => {
  it("extracts the wunderground URL and source", () => {
    expect(parseResolutionUrl(LONDON_DESC)).toContain("wunderground.com");
    expect(parseResolutionSource(LONDON_DESC)).toBe("weather_underground");
  });
  it("detects NWS source", () => {
    expect(parseResolutionSource("resolves per the NWS climate report")).toBe("nws");
  });
});

describe("analyzeMarket", () => {
  it("classifies a real London threshold market with full context", () => {
    const r = analyzeMarket(
      {
        id: "1",
        question: "Will the highest temperature in London be 19°C or below on June 13?",
        description: LONDON_DESC,
      },
      "Highest temperature in London on June 13?",
    );
    expect(r.isTemperature).toBe(true);
    expect(r.location).toBe("London");
    expect(r.resolutionStation).toBe("London Heathrow Airport Station");
    expect(r.resolutionSource).toBe("weather_underground");
    expect(r.resolutionUrl).toContain("wunderground.com");
  });

  it("does not classify non-temperature markets", () => {
    const r = analyzeMarket({ id: "3", question: "Will the Lakers win tonight?" });
    expect(r.isTemperature).toBe(false);
  });
});

describe("decodeJsonArray", () => {
  it("decodes Gamma's JSON-encoded string arrays", () => {
    expect(decodeJsonArray('["0.51","0.49"]')).toEqual(["0.51", "0.49"]);
  });
  it("returns [] for undefined/garbage", () => {
    expect(decodeJsonArray(undefined)).toEqual([]);
    expect(decodeJsonArray("not json")).toEqual([]);
  });
});
