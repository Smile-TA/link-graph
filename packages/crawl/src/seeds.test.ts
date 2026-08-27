import { describe, expect, it } from "vitest";
import type { SiteRow } from "@link-graph/db";
import { seedProblem, type CrawlSeeds } from "./seeds.js";

const site = (overrides: Partial<SiteRow> = {}): SiteRow => ({
  id: 1,
  siteId: "403bplan-net",
  canonicalHost: "403bplan.net",
  aliases: ["403bplan.net", "www.403bplan.net"],
  stageHost: null,
  enabled: true,
  truthSource: "sitemap",
  crawlerMode: "http",
  crawlScope: "full",
  sampleCeiling: null,
  rateLimit: 1,
  ignorePaths: [],
  ...overrides,
});

/**
 * Inventory URLs as seeds. The post type is `null` throughout: `seedProblem` reads only
 * the URL, so a value here would be one nothing in this file can observe.
 */
const urls = (...list: string[]) => list.map((url) => ({ url, postType: null }));

const seeds = (overrides: Partial<CrawlSeeds> = {}): CrawlSeeds => ({
  urls: urls("https://403bplan.net/", "https://403bplan.net/contact-us/"),
  truthSourceUrls: 2,
  truthSourceRestUrls: null,
  truthSourceSitemapUrls: 2,
  taxonomies: [],
  ...overrides,
});

describe("seedProblem", () => {
  it("accepts a resolved inventory", () => {
    expect(seedProblem(site(), seeds())).toBeNull();
  });

  it("refuses a seed that is not the identity the crawler would store", () => {
    // `/contact-us` and `/contact-us/` are one page and two nodes. A crawl seeded with
    // the unslashed form plants a fake orphan that no amount of correct graph maths
    // downstream can undo (PRD §13).
    const problem = seedProblem(
      site(),
      seeds({ urls: urls("https://403bplan.net/", "https://403bplan.net/contact-us") }),
    );
    expect(problem).toMatch(/not normalized/i);
    expect(problem).toContain("https://403bplan.net/contact-us/");
  });

  it("refuses a seed on another host", () => {
    const problem = seedProblem(
      site(),
      seeds({ urls: urls("https://403bplan.net/", "https://integrity.com/") }),
    );
    expect(problem).toMatch(/not on this site/i);
  });

  it("refuses a duplicated seed rather than silently deduplicating it", () => {
    // The inventory size is the denominator of the coverage gate, so a list that says
    // 2 and holds 1 distinct URL overstates what the crawl is measured against.
    const problem = seedProblem(
      site(),
      seeds({ urls: urls("https://403bplan.net/", "https://403bplan.net/") }),
    );
    expect(problem).toMatch(/duplicate/i);
  });

  it("refuses a site with a truth source and no seeds", () => {
    // A 200 with an empty array is a failed resolution, never an answer (PRD §4).
    const problem = seedProblem(
      site(),
      seeds({ urls: [], truthSourceUrls: null, truthSourceSitemapUrls: null }),
    );
    expect(problem).toMatch(/no seed/i);
  });

  it("refuses seeds for a site that was resolved to have no truth source", () => {
    // Mirrors the fixture parser: a site with no inventory cannot have a size for one,
    // and 006_truth_source.sql would refuse the row anyway.
    const problem = seedProblem(
      site({ truthSource: "none" }),
      seeds({ truthSourceUrls: null, truthSourceSitemapUrls: null }),
    );
    expect(problem).toMatch(/not an inventory/i);
  });

  it("allows a site with no truth source to be crawled from its homepage alone", () => {
    // PRD §4: such a site is still crawlable for broken links and structure. It reports
    // `undetectable`, never zero orphans.
    const problem = seedProblem(
      site({ truthSource: "none" }),
      seeds({ urls: [], truthSourceUrls: null, truthSourceSitemapUrls: null }),
    );
    expect(problem).toBeNull();
  });

  it("refuses an inventory whose size disagrees with the seed list", () => {
    const problem = seedProblem(
      site(),
      seeds({ truthSourceUrls: 13, truthSourceSitemapUrls: 13 }),
    );
    expect(problem).toMatch(/13/);
  });

  it("refuses an inventory with no recorded size", () => {
    // Without it `analyse` cannot tell one page of 1,953 from a complete crawl, which
    // is the hole 006_truth_source.sql exists to close.
    const problem = seedProblem(
      site(),
      seeds({ truthSourceUrls: null, truthSourceSitemapUrls: null }),
    );
    expect(problem).toMatch(/size/i);
  });

  it("refuses a sample ceiling that is not smaller than the inventory", () => {
    // Left undone by step 5.5 and owned here, because the crawler is the thing that
    // reads the ceiling. A `sample` site whose ceiling exceeds its page count is
    // crawled whole and still reports `orphans: null, reason: sampled` — suppressing a
    // count it could have produced, which is the mirror image of reporting a zero
    // nobody measured.
    const problem = seedProblem(
      site({ crawlScope: "sample", sampleCeiling: 2 }),
      seeds(),
    );
    expect(problem).toMatch(/ceiling/i);
    expect(
      seedProblem(site({ crawlScope: "sample", sampleCeiling: 3 }), seeds()),
    ).toMatch(/ceiling/i);
    expect(
      seedProblem(site({ crawlScope: "sample", sampleCeiling: 1 }), seeds()),
    ).toBeNull();
  });

  it("does not compare a ceiling with an inventory that does not exist", () => {
    // A templated site with no truth source has no number to compare against; refusing
    // it would be an invented rule.
    expect(
      seedProblem(
        site({ truthSource: "none", crawlScope: "sample", sampleCeiling: 500 }),
        seeds({ urls: [], truthSourceUrls: null, truthSourceSitemapUrls: null }),
      ),
    ).toBeNull();
  });
});
