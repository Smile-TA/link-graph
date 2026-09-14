import { describe, expect, it } from "vitest";
import { diffCrawls } from "./diff.js";

describe("diffCrawls", () => {
  it("is empty for a first crawl", () => {
    expect(diffCrawls(null)).toEqual([]);
  });

  it("reports appeared and resolved orphans and broken links separately", () => {
    const diffs = diffCrawls({
      previousOrphans: ["/a/", "/b/"],
      currentOrphans: ["/b/", "/c/"],
      previousBroken: ["/x/"],
      currentBroken: [],
      previousTag: null,
      currentTag: null,
    });
    expect(diffs).toEqual(
      expect.arrayContaining([
        { kind: "orphan_appeared", url: "/c/", detail: null },
        { kind: "orphan_resolved", url: "/a/", detail: null },
        { kind: "broken_resolved", url: "/x/", detail: null },
      ]),
    );
    expect(diffs).toHaveLength(3);
  });

  it("stamps the release change when both crawls carry a tag", () => {
    const diffs = diffCrawls({
      previousOrphans: [],
      currentOrphans: ["/new/"],
      previousBroken: [],
      currentBroken: [],
      previousTag: "v1.6.8",
      currentTag: "v1.7.0",
    });
    expect(diffs).toEqual([
      { kind: "orphan_appeared", url: "/new/", detail: "v1.6.8 → v1.7.0" },
    ]);
  });

  it("leaves detail null rather than printing 'unknown' when either tag is missing", () => {
    const diffs = diffCrawls({
      previousOrphans: [],
      currentOrphans: ["/new/"],
      previousBroken: [],
      currentBroken: [],
      previousTag: null,
      currentTag: "v1.7.0",
    });
    expect(diffs[0]?.detail).toBeNull();
  });
});
