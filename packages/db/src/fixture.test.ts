/**
 * The fixture contract, checked with no database running (engineering guide §4.3).
 *
 * `parseCrawlFixture` is pure, so everything the JSON shape promises — required
 * fields, derived fields, rejected fields — is a unit test. The only things left for
 * the integration tier are the writes themselves.
 *
 * URLs here are real: lionstreet.com pages from the checked-in sitemap corpus and
 * links from its captured homepage.
 */
import { describe, expect, it } from "vitest";
import { parseCrawlFixture } from "./fixture.js";
import { CAPTURE_SITES, captureCrawlJson, expectedLinks } from "./testing/captures.js";

/** A minimal valid fixture. Each test mutates a fresh copy. */
const validJson = (): Record<string, unknown> => ({
  site: {
    siteId: "lionstreet-com",
    canonicalHost: "lionstreet.com",
    aliases: ["lionstreet.com", "www.lionstreet.com"],
    truthSource: "sitemap",
  },
  crawl: { status: "complete", startedAt: "2026-08-20T00:00:00.000Z" },
  pages: [
    {
      url: "https://lionstreet.com/",
      statusCode: 200,
      inTruthSource: true,
      indexable: true,
    },
    {
      url: "https://lionstreet.com/testimonials/",
      statusCode: 200,
      inTruthSource: true,
      indexable: true,
    },
  ],
  links: [
    {
      from: "https://lionstreet.com/",
      to: "https://lionstreet.com/testimonials/",
      anchor: "Testimonials",
      container: "header",
    },
    {
      from: "https://lionstreet.com/",
      to: "https://www.linkedin.com/company/lion-street/",
      anchor: "LinkedIn",
      container: "footer",
    },
  ],
});

/** Mutate a deep copy of the valid fixture. */
function json(mutate: (j: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(validJson());
  mutate(copy);
  return copy;
}

const pagesOf = (j: unknown): Record<string, unknown>[] =>
  (j as { pages: Record<string, unknown>[] }).pages;
const linksOf = (j: unknown): Record<string, unknown>[] =>
  (j as { links: Record<string, unknown>[] }).links;
const siteOf = (j: unknown): Record<string, unknown> =>
  (j as { site: Record<string, unknown> }).site;
const crawlOf = (j: unknown): Record<string, unknown> =>
  (j as { crawl: Record<string, unknown> }).crawl;

describe("parseCrawlFixture: what it accepts", () => {
  it("accepts a minimal fixture and keeps every field it was given", () => {
    const fixture = parseCrawlFixture(validJson());
    expect(fixture.site.siteId).toBe("lionstreet-com");
    expect(fixture.site.enabled).toBe(true);
    expect(fixture.site.crawlerMode).toBe("http");
    expect(fixture.site.rateLimit).toBe(1);
    expect(fixture.crawl.env).toBe("prod");
    expect(fixture.crawl.status).toBe("complete");
    expect(fixture.crawl.startedAt).toEqual(new Date("2026-08-20T00:00:00.000Z"));
    expect(fixture.pages).toHaveLength(2);
    expect(fixture.links).toHaveLength(2);
  });

  it("derives path from the URL, including the query", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        pagesOf(j)[1] = {
          url: "https://lionstreet.com/?s=advisor",
          inTruthSource: false,
          indexable: false,
        };
      }),
    );
    expect(fixture.pages.map((p) => p.path)).toEqual(["/", "/?s=advisor"]);
  });

  it("derives isExternal from the site's alias set, not from a field", () => {
    const fixture = parseCrawlFixture(validJson());
    expect(fixture.links.map((l) => l.isExternal)).toEqual([false, true]);
  });

  it("numbers domIndex per page when it is omitted", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        linksOf(j).push({
          from: "https://lionstreet.com/testimonials/",
          to: "https://lionstreet.com/",
          anchor: "Home",
          container: "header",
        });
      }),
    );
    expect(fixture.links.map((l) => [l.fromUrl, l.domIndex])).toEqual([
      ["https://lionstreet.com/", 0],
      ["https://lionstreet.com/", 1],
      ["https://lionstreet.com/testimonials/", 0],
    ]);
  });

  it("keeps an explicit domIndex", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        linksOf(j)[0]!.domIndex = 42;
      }),
    );
    expect(fixture.links[0]?.domIndex).toBe(42);
  });

  it("leaves analyse's own columns null rather than defaulting them", () => {
    const fixture = parseCrawlFixture(validJson());
    expect(fixture.pages[0]?.depth).toBeNull();
    expect(fixture.pages[0]?.class).toBeNull();
    expect(fixture.links[0]?.isBoilerplate).toBeNull();
  });

  it("accepts an explicit depth, class and isBoilerplate, for seeding an analysed crawl", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        pagesOf(j)[1]!.depth = 1;
        pagesOf(j)[1]!.class = "orphan";
        linksOf(j)[0]!.isBoilerplate = true;
      }),
    );
    expect(fixture.pages[1]?.depth).toBe(1);
    expect(fixture.pages[1]?.class).toBe("orphan");
    expect(fixture.links[0]?.isBoilerplate).toBe(true);
  });

  it("accepts a partial crawl, and does not turn it into a complete one", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        crawlOf(j).status = "partial";
        crawlOf(j).wasThrottled = true;
      }),
    );
    expect(fixture.crawl.status).toBe("partial");
    expect(fixture.crawl.wasThrottled).toBe(true);
  });
});

describe("parseCrawlFixture: what it refuses", () => {
  it("refuses a page URL that is not already normalized, and says what it should be", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[1]!.url = "https://lionstreet.com/testimonials";
        }),
      ),
    ).toThrow(/normalizes to https:\/\/lionstreet\.com\/testimonials\//);
  });

  it("refuses a page URL that is not on this site", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[1]!.url = "https://integrity.com/about/";
        }),
      ),
    ).toThrow(/not on this site/);
  });

  it("refuses a link target that is not normalized", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          linksOf(j)[0]!.to = "https://lionstreet.com/testimonials/?utm_source=x";
        }),
      ),
    ).toThrow(/not normalized/);
  });

  it("refuses two pages with the same URL", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[1]!.url = "https://lionstreet.com/";
        }),
      ),
    ).toThrow(/duplicate url/);
  });

  it("refuses a link whose from names no page in the fixture", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          linksOf(j)[0]!.from = "https://lionstreet.com/terms-and-conditions/";
        }),
      ),
    ).toThrow(/from names no page/);
  });

  it("refuses a container outside extractPage's vocabulary", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          linksOf(j)[0]!.container = "sidebar";
        }),
      ),
    ).toThrow(/container must be one of/);
  });

  it("refuses an unknown field, because a typo would otherwise land as null", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[0]!.indexible = true;
        }),
      ),
    ).toThrow(/unknown field\(s\) indexible/);
  });

  it("requires indexable — defaulting it to true manufactures orphans", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          delete pagesOf(j)[0]!.indexable;
        }),
      ),
    ).toThrow(/indexable is required/);
  });

  it("requires inTruthSource", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          delete pagesOf(j)[0]!.inTruthSource;
        }),
      ),
    ).toThrow(/inTruthSource is required/);
  });

  it("requires the crawl status", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          delete crawlOf(j).status;
        }),
      ),
    ).toThrow(/status is required/);
  });

  it("requires the site's truthSource, so 'not resolved' cannot pass as 'none'", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          delete siteOf(j).truthSource;
        }),
      ),
    ).toThrow(/truthSource is required/);
  });

  it("refuses aliases that omit the canonical host", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          siteOf(j).aliases = ["www.lionstreet.com"];
        }),
      ),
    ).toThrow(/aliases must include canonicalHost/);
  });

  it("refuses a fixture with no pages", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          j.pages = [];
          j.links = [];
        }),
      ),
    ).toThrow(/at least one page/);
  });

  it("refuses a wrongly typed field", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[0]!.statusCode = "200";
        }),
      ),
    ).toThrow(/statusCode must be an integer/);
  });

  /**
   * The class vocabulary is analyse's output (step 4) and belongs to `pages.class`, so a
   * fixture that names a class outside it is a typo, not data. It was a real one: this
   * file's sibling integration test carried `class: "content"` until the vocabulary
   * landed, and nothing rejected it.
   */
  it("refuses a page class outside the vocabulary", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[0]!.class = "content";
        }),
      ),
    ).toThrow(/class must be one of .*orphan.*got content/);
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[0]!.class = "soft_orphan";
        }),
      ),
    ).not.toThrow();
  });

  it("refuses anything that is not an object", () => {
    expect(() => parseCrawlFixture(null)).toThrow(/expected an object/);
    expect(() => parseCrawlFixture([])).toThrow(/expected an object/);
  });

  it("names the page that is wrong", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          delete pagesOf(j)[1]!.indexable;
        }),
      ),
    ).toThrow(/pages\[1\]/);
  });
});

/**
 * How large the truth source was (step 5, `006_truth_source.sql`). Without it a crawl of
 * one page of a 1,953-URL site loads as a complete crawl, and `analyse` reports
 * `orphans: 0` — engineering guide §1's opening example.
 */
describe("parseCrawlFixture: the size of the truth source", () => {
  const withCrawl = (crawl: Record<string, unknown>) => {
    const json = validJson();
    crawlOf(json).truthSourceUrls = crawl["truthSourceUrls"];
    crawlOf(json).truthSourceRestUrls = crawl["truthSourceRestUrls"];
    crawlOf(json).truthSourceSitemapUrls = crawl["truthSourceSitemapUrls"];
    return json;
  };

  it("defaults all three counts to null, which analyse then refuses to guess at", () => {
    expect(parseCrawlFixture(validJson()).crawl).toMatchObject({
      truthSourceUrls: null,
      truthSourceRestUrls: null,
      truthSourceSitemapUrls: null,
    });
  });

  it("accepts the union with one or both per-source counts", () => {
    expect(
      parseCrawlFixture(withCrawl({ truthSourceUrls: 55, truthSourceSitemapUrls: 55 }))
        .crawl.truthSourceUrls,
    ).toBe(55);
    // integrity.com's `page` post type, measured: REST 124, sitemap 96, union 124.
    expect(
      parseCrawlFixture(
        withCrawl({
          truthSourceUrls: 124,
          truthSourceRestUrls: 124,
          truthSourceSitemapUrls: 96,
        }),
      ).crawl,
    ).toMatchObject({
      truthSourceUrls: 124,
      truthSourceRestUrls: 124,
      truthSourceSitemapUrls: 96,
    });
  });

  it("refuses a size for a site that has no truth source", () => {
    const json = withCrawl({ truthSourceUrls: 55, truthSourceSitemapUrls: 55 });
    (json["site"] as Record<string, unknown>)["truthSource"] = "none";
    expect(() => parseCrawlFixture(json)).toThrow(/no inventory cannot have a size/);
  });

  it("refuses a union with no source behind it", () => {
    expect(() => parseCrawlFixture(withCrawl({ truthSourceUrls: 55 }))).toThrow(
      /which source measured it/,
    );
  });

  it("refuses a per-source count with no union", () => {
    expect(() => parseCrawlFixture(withCrawl({ truthSourceSitemapUrls: 55 }))).toThrow(
      /required when either per-source count/,
    );
  });

  it("refuses an inventory of nothing", () => {
    expect(() =>
      parseCrawlFixture(withCrawl({ truthSourceUrls: 0, truthSourceSitemapUrls: 0 })),
    ).toThrow(/inventory of nothing/);
  });

  it("refuses a union that is not one: smaller than a source, or larger than the sum", () => {
    expect(() =>
      parseCrawlFixture(
        withCrawl({
          truthSourceUrls: 96,
          truthSourceRestUrls: 124,
          truthSourceSitemapUrls: 96,
        }),
      ),
    ).toThrow(/must be between 124 and 220/);
    expect(() =>
      parseCrawlFixture(
        withCrawl({
          truthSourceUrls: 300,
          truthSourceRestUrls: 124,
          truthSourceSitemapUrls: 96,
        }),
      ),
    ).toThrow(/must be between 124 and 220/);
  });
});

describe("parseCrawlFixture: the alias set is load-bearing", () => {
  /**
   * 145 of 312 prod hostnames are `www.` aliases (PRD §3), and the alias set is what
   * decides internal versus external for every edge. These two tests are the pair
   * that notices if it stops being used: the same href is a rejected non-identity
   * with the alias declared, and a legitimate external node without it.
   */
  const wwwTarget = (aliases: string[]) =>
    json((j) => {
      siteOf(j).aliases = aliases;
      linksOf(j)[0]!.to = "https://www.lionstreet.com/careers/";
    });

  it("treats a www target as the apex page, so it is not node identity", () => {
    expect(() =>
      parseCrawlFixture(wwwTarget(["lionstreet.com", "www.lionstreet.com"])),
    ).toThrow(/normalizes to https:\/\/lionstreet\.com\/careers\//);
  });

  it("treats the same href as an external node when www is not declared", () => {
    const fixture = parseCrawlFixture(wwwTarget(["lionstreet.com"]));
    expect(fixture.links[0]).toMatchObject({
      toUrlNormalized: "https://www.lionstreet.com/careers/",
      isExternal: true,
    });
  });

  it("refuses an alias that is not a bare hostname", () => {
    for (const alias of ["www.lionstreet.com/", "https://www.lionstreet.com", ""]) {
      expect(() =>
        parseCrawlFixture(
          json((j) => {
            siteOf(j).aliases = ["lionstreet.com", alias];
          }),
        ),
      ).toThrow(/must be a bare hostname/);
    }
  });
});

describe("parseCrawlFixture: canonicalTo, redirectTo and timestamps", () => {
  it("requires canonicalTo to be normalized, since step 4 joins on it", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[1]!.canonicalTo = "https://lionstreet.com/testimonials";
        }),
      ),
    ).toThrow(/canonicalTo is not normalized/);
  });

  it("allows a canonical that points off-site — that is the Excluded class", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        pagesOf(j)[1]!.canonicalTo = "https://integrity.com/testimonials";
      }),
    );
    expect(fixture.pages[1]?.canonicalTo).toBe("https://integrity.com/testimonials");
  });

  it("requires redirectTo to be normalized too", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          pagesOf(j)[1]!.redirectTo = "https://lionstreet.com/testimonials?utm_source=x";
        }),
      ),
    ).toThrow(/redirectTo is not normalized/);
  });

  it("refuses a timestamp with no UTC offset, which would mean the host's zone", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          crawlOf(j).startedAt = "2026-08-20T09:00:00";
        }),
      ),
    ).toThrow(/must be an ISO 8601 instant with an offset/);
  });

  it("refuses a date that is not ISO 8601 at all", () => {
    expect(() =>
      parseCrawlFixture(
        json((j) => {
          crawlOf(j).finishedAt = "08/20/2026";
        }),
      ),
    ).toThrow(/must be an ISO 8601 instant with an offset/);
  });

  it("accepts an offset that is not Z", () => {
    const fixture = parseCrawlFixture(
      json((j) => {
        crawlOf(j).startedAt = "2026-08-20T11:00:00+02:00";
      }),
    );
    expect(fixture.crawl.startedAt).toEqual(new Date("2026-08-20T09:00:00.000Z"));
  });
});

describe("parseCrawlFixture: it can carry what extractPage produces", () => {
  for (const site of CAPTURE_SITES) {
    it(`accepts a crawl built from ${site.canonicalHost}'s captures`, () => {
      const fixture = parseCrawlFixture(captureCrawlJson(site));
      expect(fixture.pages).toHaveLength(site.captures.length);
      expect(fixture.links).toHaveLength(expectedLinks(site));
      // Every link's from must have resolved to one of the captured pages, and every
      // container must be in the schema's CHECK vocabulary.
      const urls = new Set(fixture.pages.map((p) => p.urlNormalized));
      expect(fixture.links.every((l) => urls.has(l.fromUrl))).toBe(true);
    });
  }

  it("carries every link of every capture, 539 in total", () => {
    let total = 0;
    for (const site of CAPTURE_SITES) {
      const links = parseCrawlFixture(captureCrawlJson(site)).links.length;
      expect(links, site.canonicalHost).toBe(expectedLinks(site));
      total += links;
    }
    // The figure step 2 measured from the raw markup, not from cheerio.
    expect(total).toBe(539);
  });

  it("carries the noindex capture as indexable: false", () => {
    const tidewater = CAPTURE_SITES.find((s) => s.canonicalHost === "tidewatermg.com");
    const fixture = parseCrawlFixture(captureCrawlJson(tidewater!));
    expect(
      fixture.pages.map((p) => [p.urlNormalized, p.indexable, p.canonicalTo]),
    ).toEqual([
      ["https://tidewatermg.com/", true, "https://tidewatermg.com/"],
      ["https://tidewatermg.com/?s=medicare", false, null],
    ]);
  });
});
