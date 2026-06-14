import { describe, expect, it } from "vitest";
import { BookSchema, summariseBook } from "./clob.js";

describe("summariseBook", () => {
  it("computes best bid/ask, midpoint and spread", () => {
    const book = BookSchema.parse({
      bids: [
        { price: "0.40", size: "100" },
        { price: "0.45", size: "50" },
      ],
      asks: [
        { price: "0.55", size: "100" },
        { price: "0.60", size: "20" },
      ],
    });
    const s = summariseBook(book);
    expect(s.bestBid).toBe(0.45);
    expect(s.bestAsk).toBe(0.55);
    expect(s.midpoint).toBeCloseTo(0.5);
    expect(s.spread).toBeCloseTo(0.1);
  });

  it("returns nulls for an empty side", () => {
    const book = BookSchema.parse({ bids: [], asks: [] });
    const s = summariseBook(book);
    expect(s.bestBid).toBeNull();
    expect(s.midpoint).toBeNull();
  });
});
