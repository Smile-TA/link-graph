import { describe, expect, it } from "vitest";
import { crawlsToPrune } from "./retention.js";

describe("crawlsToPrune", () => {
  it("keeps the 12 newest and prunes the rest", () => {
    const ids = Array.from({ length: 15 }, (_, i) => 15 - i); // [15, 14, ..., 1]
    expect(crawlsToPrune(ids)).toEqual([3, 2, 1]);
  });

  it("prunes nothing when there are 12 or fewer", () => {
    expect(crawlsToPrune([3, 2, 1])).toEqual([]);
  });
});
