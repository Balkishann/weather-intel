import { describe, expect, it } from "vitest";
import { fahrenheitToCelsius, stableHash, toNumber } from "./util.js";

describe("stableHash", () => {
  it("is order-independent for object keys", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
  it("differs when values differ", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
  it("is sensitive to array order", () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });
});

describe("toNumber", () => {
  it("parses numeric strings and numbers", () => {
    expect(toNumber("0.51")).toBe(0.51);
    expect(toNumber(3)).toBe(3);
  });
  it("returns null for empty/invalid", () => {
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("abc")).toBeNull();
  });
});

describe("fahrenheitToCelsius", () => {
  it("converts known points", () => {
    expect(fahrenheitToCelsius(32)).toBeCloseTo(0);
    expect(fahrenheitToCelsius(212)).toBeCloseTo(100);
  });
});
