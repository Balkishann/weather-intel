import { describe, expect, it } from "vitest";
import {
  checkComplementaryPrices,
  checkNotFuture,
  checkPriceInRange,
  checkTemperaturePlausible,
} from "./validation.js";

describe("checkPriceInRange", () => {
  it("passes for prices in [0,1]", () => {
    expect(checkPriceInRange("p", 0.5).passed).toBe(true);
    expect(checkPriceInRange("p", 0).passed).toBe(true);
    expect(checkPriceInRange("p", 1).passed).toBe(true);
  });
  it("fails for out-of-range and null", () => {
    expect(checkPriceInRange("p", 1.2).passed).toBe(false);
    expect(checkPriceInRange("p", -0.1).passed).toBe(false);
    expect(checkPriceInRange("p", null).passed).toBe(false);
  });
});

describe("checkComplementaryPrices", () => {
  it("passes when yes+no ~= 1", () => {
    expect(checkComplementaryPrices(0.51, 0.49).passed).toBe(true);
  });
  it("flags drift beyond tolerance", () => {
    expect(checkComplementaryPrices(0.6, 0.6).passed).toBe(false);
  });
  it("fails on missing", () => {
    expect(checkComplementaryPrices(null, 0.5).passed).toBe(false);
  });
});

describe("checkTemperaturePlausible", () => {
  it("accepts earthly temperatures", () => {
    expect(checkTemperaturePlausible("t", 35).passed).toBe(true);
    expect(checkTemperaturePlausible("t", -40).passed).toBe(true);
  });
  it("rejects implausible / null", () => {
    expect(checkTemperaturePlausible("t", 999).passed).toBe(false);
    expect(checkTemperaturePlausible("t", null).passed).toBe(false);
  });
});

describe("checkNotFuture", () => {
  const now = new Date("2026-06-13T12:00:00Z");
  it("passes for past timestamps", () => {
    expect(checkNotFuture("t", new Date("2026-06-13T11:00:00Z"), now).passed).toBe(true);
  });
  it("fails for clearly future timestamps", () => {
    expect(checkNotFuture("t", new Date("2026-06-13T13:00:00Z"), now).passed).toBe(false);
  });
});
