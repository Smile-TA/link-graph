import { describe, expect, it } from "vitest";
import { loadCuration } from "./curation.js";

describe("loadCuration", () => {
  it("loads the checked-in overlay as an object keyed by app dir", async () => {
    const curation = await loadCuration();
    expect(Object.keys(curation).length).toBeGreaterThan(0);
    // Every entry the file ships today is an exclusion (variant dirs and utilities);
    // this only pins the shape, not the count, so adding a real crawlerMode/rateLimit
    // override later does not break this test.
    for (const entry of Object.values(curation)) {
      expect(typeof entry).toBe("object");
    }
  });

  it("integrity.com's own app dir is excluded — the live host is a dated variant", async () => {
    const curation = await loadCuration();
    expect(curation["integrity.com"]?.excluded).toBe(true);
  });
});
