/**
 * Sitemap parsing, against recorded production sitemaps.
 *
 * The numbers below are the point of the file: they were measured on 2026-08-20 and two
 * of them contradict `census.json` (see `agent.familyfirstlife.com` below).
 */
import { describe, expect, it } from "vitest";
import { parseSitemap, sitemapChild, SITEMAP_CANDIDATES } from "./sitemap.js";
import { recordedBody, recordedResponse } from "./testing/recorded.js";

describe("parseSitemap over real estate sitemaps", () => {
  it("reads a Yoast index and its one child (403bplan.net)", () => {
    const index = parseSitemap(recordedBody("https://403bplan.net/sitemap_index.xml"));
    expect(index).toEqual({
      kind: "index",
      locs: ["https://403bplan.net/page-sitemap.xml"],
    });
    const child = parseSitemap(recordedBody("https://403bplan.net/page-sitemap.xml"));
    expect(child?.kind).toBe("urlset");
    expect(child?.locs).toHaveLength(13);
    expect(child?.locs[0]).toBe("https://403bplan.net/");
  });

  it("reads integrity.com's 14 children, which include no promotion or webinar", () => {
    const index = parseSitemap(recordedBody("https://integrity.com/sitemap_index.xml"));
    expect(index?.kind).toBe("index");
    expect(index?.locs).toHaveLength(14);
    // PRD §4 names these two post types as REST-only, and the index is where that is
    // visible: there is no promotion-sitemap.xml or webinar-sitemap.xml to fetch.
    expect(index?.locs.filter((l) => /promotion|webinar/.test(l))).toEqual([]);
  });

  it("reads tidewatermg.com's 34 children — census.json records 33", () => {
    const index = parseSitemap(recordedBody("https://tidewatermg.com/sitemap_index.xml"));
    expect(index?.locs).toHaveLength(34);
    // PRD §2's page-builder artifacts are IN the sitemap, as their own child.
    expect(index?.locs).toContain("https://tidewatermg.com/bricks_template-sitemap.xml");
  });

  it("is not fooled by an HTML 404 body (123.planenroll.com)", () => {
    expect(
      parseSitemap(recordedBody("https://123.planenroll.com/sitemap_index.xml")),
    ).toBe(null);
  });

  it("ignores a commented-out <url>, because a parser is not a regex", () => {
    const xml =
      `<urlset><url><loc>https://a.example/</loc></url>` +
      `<!-- <url><loc>https://b.example/</loc></url> --></urlset>`;
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", locs: ["https://a.example/"] });
  });

  it("tries the three PRD §4 candidates in order", () => {
    expect(SITEMAP_CANDIDATES).toEqual([
      "/sitemap_index.xml",
      "/sitemap.xml",
      "/wp-sitemap.xml",
    ]);
  });
});

/**
 * **The 2,000 in `census.json` is a paginated WP-core sitemap index read one child
 * deep, not a truncated sitemap.** PRD §1 footnotes it as "exactly 2,000 indicates a
 * truncated sitemap; true count unknown and higher", and the plan says only a REST
 * cross-check can catch it. Both are wrong: following the index catches it, and the
 * true count is knowable.
 */
describe("agent.familyfirstlife.com — the census's 2,000", () => {
  const child = (n: number) => {
    const doc = parseSitemap(
      recordedBody(`https://agent.familyfirstlife.com/wp-sitemap-posts-page-${n}.xml`),
    );
    if (doc === null) throw new Error(`child ${n} did not parse as a sitemap`);
    return doc;
  };

  it("lists 30 children, not one", () => {
    const index = parseSitemap(
      recordedBody("https://agent.familyfirstlife.com/wp-sitemap.xml"),
    );
    expect(index?.kind).toBe("index");
    expect(index?.locs).toHaveLength(30);
    expect(index?.locs[29]).toBe(
      "https://agent.familyfirstlife.com/wp-sitemap-posts-page-30.xml",
    );
  });

  it("holds exactly 2,000 URLs in its first child — WP core's per-file cap", () => {
    expect(child(1).locs).toHaveLength(2000);
  });

  /**
   * The last child holds the remainder, and it arrived with **HTTP 404** while carrying
   * 1,362 real URLs — recorded in `recorded.json`, asserted in `resolve.test.ts`.
   */
  it("holds the remainder in its last child, disjoint from the first", () => {
    const last = child(30);
    expect(last.locs).toHaveLength(1362);
    // Non-optional on purpose: `new Set(undefined)` is empty, so an optional read here
    // would make "disjoint" true for free if the 235 KB child stopped parsing.
    const first = new Set(child(1).locs);
    expect(first.size).toBe(2000);
    expect(last.locs.filter((l) => first.has(l))).toEqual([]);
  });

  /**
   * 29 full children plus the 1,362-URL remainder is 59,362 — exactly the `X-WP-Total`
   * the `page` post type reports. Written as a division so that it asserts the two
   * independent sources agree rather than asserting a hand-copied constant: only if the
   * 28 children we did not record are full does the arithmetic land on a whole number
   * equal to the index's own child count.
   */
  it("agrees with REST's 59,362 once every child is counted", () => {
    // Both numbers are read from the recordings, not typed in: the REST total from the
    // response header, the child count from the index. Gate 2 caught the first version
    // hard-coding 59362 and asserting `29 + 1 === 30`, which cannot fail.
    const declared = recordedResponse(
      "https://agent.familyfirstlife.com/wp-json/wp/v2/pages?per_page=1&_fields=id,link,type,status",
    ).headers["x-wp-total"];
    const restTotal = Number(declared);
    expect(restTotal).toBe(59362);
    const children = parseSitemap(
      recordedBody("https://agent.familyfirstlife.com/wp-sitemap.xml"),
    )?.locs.length;
    // Children 2–29 were not fetched, so this is inference and not measurement — but it
    // is inference the two sources have to agree on: the REST total minus the measured
    // remainder is a whole number of full 2,000-URL children, and that number is exactly
    // the index's own child count minus the remainder page.
    const remainder = child(30).locs.length;
    expect((restTotal - remainder) % 2000).toBe(0);
    expect((restTotal - remainder) / 2000).toBe((children ?? 0) - 1);
    // census.json records 2,000 URLs and 1 child for this host.
    expect(restTotal).toBeGreaterThan(2000 * 29);
  });
});

/**
 * The child sitemap's own name — the only provenance a sitemap-resolved URL can carry.
 *
 * PRD §4 wants taxonomy archives, author archives and page-builder artifacts in the
 * Excluded class, and measured ~10% of tidewatermg.com's sitemap is one of the three.
 * Nothing in a `<urlset>` says which; the file the URL came out of does, and step 5 was
 * throwing that name away.
 */
describe("sitemapChild: which CMS object a child sitemap lists", () => {
  it("reads Yoast's <object>-sitemap.xml — every name below is a recorded child", () => {
    expect(sitemapChild("https://integrity.com/page-sitemap.xml")).toBe("page");
    expect(sitemapChild("https://integrity.com/insights_category-sitemap.xml")).toBe(
      "insights_category",
    );
    expect(sitemapChild("https://tidewatermg.com/bricks_template-sitemap.xml")).toBe(
      "bricks_template",
    );
    expect(sitemapChild("https://tidewatermg.com/author-sitemap.xml")).toBe("author");
  });

  it("names all 34 of tidewatermg.com's children and all 14 of integrity.com's", () => {
    for (const [host, children] of [
      ["tidewatermg.com", 34],
      ["integrity.com", 14],
    ] as const) {
      const locs = parseSitemap(recordedBody(`https://${host}/sitemap_index.xml`))?.locs;
      // The count is asserted here and not only implied: a recorded index that had been
      // truncated would otherwise leave this green — the census failure PRD §1 records.
      expect(locs).toHaveLength(children);
      // Not one of them is unnamed: a child whose name this cannot read is a whole post
      // type or taxonomy that would carry no provenance at all.
      expect(locs?.filter((loc) => sitemapChild(loc) === null)).toEqual([]);
    }
  });

  /**
   * WP core's own sitemap. `wp-sitemap-posts-page-1.xml` is recorded
   * (agent.familyfirstlife.com, 30 children); the taxonomies and users forms are core's
   * documented naming and **no estate host serves one**, so the hosts below are named
   * to say so rather than to imply a recording.
   */
  it("reads WP core's form", () => {
    expect(
      sitemapChild("https://agent.familyfirstlife.com/wp-sitemap-posts-page-1.xml"),
    ).toBe("page");
    expect(
      sitemapChild(
        "https://not-in-this-estate.example/wp-sitemap-taxonomies-category-1.xml",
      ),
    ).toBe("category");
    expect(
      sitemapChild("https://not-in-this-estate.example/wp-sitemap-users-1.xml"),
    ).toBe("author");
  });

  it("names no object for an index or an ordinary page", () => {
    // The index candidates most of all: `/wp-sitemap.xml` ends in `-sitemap.xml` and
    // would otherwise be read as a post type called `wp`.
    for (const candidate of SITEMAP_CANDIDATES) {
      expect(sitemapChild(`https://403bplan.net${candidate}`)).toBeNull();
    }
    expect(sitemapChild("https://403bplan.net/")).toBeNull();
    expect(sitemapChild("https://403bplan.net/newsletters/")).toBeNull();
  });
});
