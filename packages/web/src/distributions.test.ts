import { describe, expect, it } from "vitest";
import {
  depthDistribution,
  inboundLinkDistribution,
  statusCodeDistribution,
} from "./distributions.js";
import type { PageAnalysisFact } from "@link-graph/db";

function page(overrides: Partial<PageAnalysisFact>): PageAnalysisFact {
  return {
    id: 1,
    crawlId: 1,
    urlNormalized: "https://example.com/",
    path: "/",
    postType: null,
    statusCode: 200,
    depth: 0,
    inTruthSource: true,
    indexable: true,
    canonicalTo: null,
    redirectTo: null,
    class: "linked",
    inboundTotal: 0,
    ...overrides,
  };
}

describe("depthDistribution", () => {
  it("buckets by depth ascending, with never-computed pages last", () => {
    const pages = [
      page({ depth: 2 }),
      page({ depth: 0 }),
      page({ depth: 0 }),
      page({ depth: null }),
    ];
    expect(depthDistribution(pages)).toEqual([
      { label: "0", count: 2 },
      { label: "2", count: 1 },
      { label: "unknown", count: 1 },
    ]);
  });

  it("omits the unknown bucket entirely when every page has a depth", () => {
    expect(depthDistribution([page({ depth: 1 })])).toEqual([{ label: "1", count: 1 }]);
  });
});

describe("statusCodeDistribution", () => {
  it("buckets by status code ascending, with never-fetched pages last", () => {
    const pages = [
      page({ statusCode: 404 }),
      page({ statusCode: 200 }),
      page({ statusCode: 200 }),
      page({ statusCode: null }),
    ];
    expect(statusCodeDistribution(pages)).toEqual([
      { label: "200", count: 2 },
      { label: "404", count: 1 },
      { label: "never fetched", count: 1 },
    ]);
  });
});

describe("inboundLinkDistribution", () => {
  it("bins inbound edge counts rather than one bar per integer", () => {
    const pages = [
      page({ inboundTotal: 0 }),
      page({ inboundTotal: 1 }),
      page({ inboundTotal: 3 }),
      page({ inboundTotal: 5 }),
      page({ inboundTotal: 200 }),
    ];
    expect(inboundLinkDistribution(pages)).toEqual([
      { label: "0", count: 1 },
      { label: "1", count: 1 },
      { label: "2–3", count: 1 },
      { label: "4–7", count: 1 },
      { label: "8–15", count: 0 },
      { label: "16+", count: 1 },
    ]);
  });

  it("returns every bin, zero-filled, even with no pages", () => {
    expect(inboundLinkDistribution([])).toEqual([
      { label: "0", count: 0 },
      { label: "1", count: 0 },
      { label: "2–3", count: 0 },
      { label: "4–7", count: 0 },
      { label: "8–15", count: 0 },
      { label: "16+", count: 0 },
    ]);
  });
});
