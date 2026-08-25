import { describe, expect, it } from "vitest";
import type { TruthSourceResult } from "@link-graph/truth";
import { crawlSeeds } from "./seeds.js";

const result = (over: Partial<TruthSourceResult> = {}): TruthSourceResult => ({
  kind: "rest",
  urls: [],
  postTypes: [],
  counts: { total: null, rest: null, sitemap: null },
  findings: [],
  requests: 0,
  ...over,
});

const truthUrl = (path: string, inRest = true, inSitemap = true) => ({
  url: `https://403bplan.net${path}`,
  path,
  postType: inRest ? "page" : null,
  inRest,
  inSitemap,
});

describe("crawlSeeds", () => {
  it("hands the inventory to the crawler with all three counts", () => {
    const seeds = crawlSeeds(
      result({
        urls: [truthUrl("/"), truthUrl("/contact-us/"), truthUrl("/news/", true, false)],
        counts: { total: 3, rest: 3, sitemap: 2 },
      }),
    );
    expect(seeds).toEqual({
      urls: [
        "https://403bplan.net/",
        "https://403bplan.net/contact-us/",
        "https://403bplan.net/news/",
      ],
      truthSourceUrls: 3,
      truthSourceRestUrls: 3,
      truthSourceSitemapUrls: 2,
    });
  });

  /**
   * The two per-source counts are the disagreement PRD §13 asks to be flagged, and they
   * are only ever read again as columns. Swapping them is invisible on a site where the
   * sources agree — which 403bplan.net does — so the case that pins them is the one
   * where they differ.
   */
  it("does not confuse the REST count with the sitemap count", () => {
    // All three distinct, and the whole object asserted: `truthSourceUrls` is the
    // denominator `analyse`'s coverage gate divides by, so filling it from either source
    // rather than from the union is the one mistake here that changes an orphan count.
    expect(
      crawlSeeds(
        result({ urls: [truthUrl("/")], counts: { total: 125, rest: 124, sitemap: 96 } }),
      ),
    ).toEqual({
      urls: ["https://403bplan.net/"],
      truthSourceUrls: 125,
      truthSourceRestUrls: 124,
      truthSourceSitemapUrls: 96,
    });
  });

  /**
   * A site with no inventory gets nulls, never zeros: `006_truth_source.sql` refuses a
   * size of 0, and a 0 would make `analyse` divide by an inventory nobody measured.
   */
  it("carries no counts at all for a site with no truth source", () => {
    expect(crawlSeeds(result({ kind: "none" }))).toEqual({
      urls: [],
      truthSourceUrls: null,
      truthSourceRestUrls: null,
      truthSourceSitemapUrls: null,
    });
  });

  it("carries no counts for a host that never answered", () => {
    expect(crawlSeeds(result({ kind: "unreachable" })).truthSourceUrls).toBeNull();
  });
});
