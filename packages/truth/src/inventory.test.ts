/**
 * Turning permalinks into node identity, and keeping the two sources apart.
 *
 * The 28 in the second block is PRD §2's `sitemap-invisible` class with a measured
 * population on the estate's most-cited site — the reason this file merges the two
 * inventories instead of letting the first success win.
 */
import { describe, expect, it } from "vitest";
import type { SiteHosts } from "@link-graph/core";
import { gather, mergeInventories, restMissing, sitemapInvisible } from "./inventory.js";
import { parseSitemap } from "./sitemap.js";
import { parseCollectionPage } from "./rest.js";
import { recordedBody, recordedResponse } from "./testing/recorded.js";

const site = (host: string): SiteHosts => ({
  canonicalHost: host,
  aliases: [host, `www.${host}`],
});

const FIELDS = "per_page=100&orderby=id&order=asc&_fields=id,link,type,status";

/** integrity.com's `page` post type over its two REST pages. */
function integrityRestPages() {
  const one = parseCollectionPage(
    recordedResponse(`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`),
  );
  const two = parseCollectionPage(
    recordedResponse(`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}&page=2`),
  );
  return [...one.items, ...two.items].map((i) => ({ url: i.link, postType: i.type }));
}

function integritySitemapPages() {
  const doc = parseSitemap(recordedBody("https://integrity.com/page-sitemap.xml"));
  return (doc?.locs ?? []).map((url) => ({ url, postType: null }));
}

describe("gather", () => {
  it("normalizes every permalink and keeps the post type", () => {
    const found = gather(integrityRestPages(), site("integrity.com"));
    expect(found.urls).toHaveLength(124);
    expect(found.urls[0]).toEqual({
      url: "https://integrity.com/",
      path: "/",
      postType: "page",
    });
    // Every REST permalink on this site is already a normalizeUrl fixed point.
    expect(found.foreign).toEqual([]);
    expect(found.unusable).toEqual([]);
    expect(found.duplicates).toBe(0);
  });

  it("counts a URL outside the alias set instead of adopting it", () => {
    const found = gather(
      [
        { url: "https://integrity.com/a/", postType: "page" },
        { url: "https://example.org/b/", postType: "page" },
        { url: "mailto:nobody@example.org", postType: "page" },
        { url: "https://integrity.com/a/", postType: "page" },
      ],
      site("integrity.com"),
    );
    expect(found.urls.map((u) => u.path)).toEqual(["/a/"]);
    expect(found.foreign).toEqual(["https://example.org/b/"]);
    expect(found.unusable).toEqual(["mailto:nobody@example.org"]);
    expect(found.duplicates).toBe(1);
  });
});

describe("mergeInventories on integrity.com's pages: REST 124, sitemap 96", () => {
  const rest = gather(integrityRestPages(), site("integrity.com")).urls;
  const sitemap = gather(integritySitemapPages(), site("integrity.com")).urls;
  const merged = mergeInventories(rest, sitemap);

  it("keeps the union, with the provenance of each URL", () => {
    expect(merged.counts).toEqual({ total: 124, rest: 124, sitemap: 96 });
    expect(merged.urls.filter((u) => u.inRest && u.inSitemap)).toHaveLength(96);
    expect(merged.urls.filter((u) => u.inRest && !u.inSitemap)).toHaveLength(28);
    expect(merged.urls.filter((u) => !u.inRest && u.inSitemap)).toHaveLength(0);
  });

  it("names 28 published pages that the sitemap does not list", () => {
    const invisible = merged.urls.filter((u) => u.inRest && !u.inSitemap);
    // Spot-checked live on 2026-08-20, not recorded here (page HTML is not a
    // truth-source response): /news/ returns 200, is self-canonical, and carries no
    // robots noindex — an indexable published page missing from the sitemap, which is
    // PRD §2's "sometimes an SEO plugin misconfiguration" rather than intent.
    expect(invisible.map((u) => u.path)).toContain("/news/");
    expect(invisible.every((u) => u.postType === "page")).toBe(true);
  });

  it("derives the sitemap-invisible count from the three counts alone", () => {
    // |REST \ sitemap| = |union| - |sitemap|, so no fourth number is stored and the
    // count is unknown — never zero — as soon as either source is missing (PRD §13).
    expect(sitemapInvisible(merged.counts)).toBe(28);
    expect(sitemapInvisible(mergeInventories(rest, null).counts)).toBe(null);
    expect(sitemapInvisible(mergeInventories(null, sitemap).counts)).toBe(null);
  });

  it("counts the disagreement in the other direction too (PRD §4)", () => {
    // Nothing on integrity.com's pages is sitemap-only, so the mirror is 0 here. It is
    // a real class elsewhere: tidewatermg.com's `bricks_template` has a sitemap child
    // and no REST post type at all.
    expect(restMissing(merged.counts)).toBe(0);
    // With REST cut to its first 50 by ascending id, the union is 106, not 96: ten of
    // those 50 are among the 28 the sitemap omits, so both directions are non-zero at
    // once — which is the case PRD §4 means by "disagree in both directions".
    const partial = mergeInventories(rest.slice(0, 50), sitemap);
    expect(partial.counts).toEqual({ total: 106, rest: 50, sitemap: 96 });
    expect(restMissing(partial.counts)).toBe(56);
    expect(sitemapInvisible(partial.counts)).toBe(10);
    expect(restMissing(mergeInventories(null, sitemap).counts)).toBe(null);
  });

  it("reports one source alone as that source, not as agreement", () => {
    expect(mergeInventories(rest, null).counts).toEqual({
      total: 124,
      rest: 124,
      sitemap: null,
    });
    expect(mergeInventories(null, null).counts).toEqual({
      total: null,
      rest: null,
      sitemap: null,
    });
    expect(mergeInventories(null, null).urls).toEqual([]);
  });
});
