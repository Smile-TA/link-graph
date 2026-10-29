/**
 * `resolveTruthSource` and the two enumerations behind it, over recorded responses.
 *
 * The end-to-end cases use the only two estate shapes small enough to record whole:
 * 403bplan.net (REST and sitemap, 13 URLs, in exact agreement) and 123.planenroll.com
 * (reachable, neither source). The pagination and refusal cases drive
 * `enumerateRest`/`enumerateSitemap` directly, because a whole-site REST enumeration of
 * integrity.com is 34 responses and of agent.familyfirstlife.com is 594.
 */
import { describe, expect, it } from "vitest";
import type { SiteHosts } from "@link-graph/core";
import {
  enumerateRest,
  enumerateSitemap,
  paginationShortfall,
  resolveTruthSource,
  TruthSourceUnresolvedError,
} from "./resolve.js";
import { declaredTaxonomies, parsePostTypes, type RestPostType } from "./rest.js";
import { parseSitemap, readSitemapResponse, sitemapChild } from "./sitemap.js";
import { recordedBody, recordedResponse, recordedFetcher } from "./testing/recorded.js";

const site = (host: string): SiteHosts & { siteId: string } => ({
  siteId: host.replace(/\./g, "-"),
  canonicalHost: host,
  aliases: [host, `www.${host}`],
});

const FIELDS = "per_page=100&orderby=id&order=asc&_fields=id,link,type,status";
/** `page` sits before `_fields` in the URL `collectionUrl` builds. */
const PAGE_2 = "per_page=100&orderby=id&order=asc&page=2&_fields=id,link,type,status";
/** One host's declared post types, straight out of its recorded `/wp/v2/types`. */
const types = (host: string) =>
  parsePostTypes(JSON.parse(recordedBody(`https://${host}/wp-json/wp/v2/types`)));

const postType = (host: string, slug: string): RestPostType => {
  const found = types(host).find((t) => t.slug === slug);
  if (found === undefined) throw new Error(`no post type ${slug} on ${host}`);
  return found;
};

describe("resolveTruthSource: 403bplan.net, where both sources agree exactly", () => {
  it("resolves to REST, and records that the sitemap said the same", async () => {
    const deps = recordedFetcher();
    const result = await resolveTruthSource(site("403bplan.net"), deps);

    expect(result.kind).toBe("rest");
    expect(result.counts).toEqual({ total: 13, rest: 13, sitemap: 13 });
    expect(result.urls).toHaveLength(13);
    expect(result.urls.every((u) => u.inRest && u.inSitemap)).toBe(true);
    expect(result.findings).toEqual([]);
    // Every page of the site, and the post type each one belongs to.
    expect(result.urls.map((u) => u.path).sort()).toEqual([
      "/",
      "/contact-us/",
      "/disclosures/",
      "/financial-advisor/",
      "/newsletter-signup/",
      "/newsletters/",
      "/plan-participant/",
      "/plan-participant/financial-calculators/",
      "/plan-participant/fund-prospectuses/",
      "/plan-participant/online-access/",
      "/plan-sponsor/",
      "/terms-of-service/",
      "/test-pay-button/",
    ]);
    expect(new Set(result.urls.map((u) => u.postType))).toEqual(new Set(["page"]));
    // The site's own taxonomy vocabulary, out of the same `/wp/v2/types` response —
    // what tells a taxonomy archive from a content post type without a second request.
    expect(result.taxonomies).toEqual([
      "category",
      "nav_menu",
      "post_tag",
      "wp_pattern_category",
    ]);
  });

  it("enumerates the post types dynamically and reports what it skipped", async () => {
    const result = await resolveTruthSource(site("403bplan.net"), recordedFetcher());
    // Declaration order, with every type accounted for: the two enumerated, and the
    // nine WordPress-internal ones named with the reason they were not.
    expect(result.postTypes.slice(0, 2)).toEqual([
      { slug: "post", restBase: "posts", urls: 0, declaredTotal: 0, skipped: null },
      { slug: "page", restBase: "pages", urls: 13, declaredTotal: 13, skipped: null },
    ]);
    expect(result.postTypes.slice(2).map((t) => [t.slug, t.urls, t.skipped])).toEqual([
      ["attachment", 0, "not-content"],
      ["nav_menu_item", 0, "not-content"],
      ["wp_block", 0, "not-content"],
      ["wp_template", 0, "not-content"],
      ["wp_template_part", 0, "not-content"],
      ["wp_global_styles", 0, "not-content"],
      ["wp_navigation", 0, "not-content"],
      ["wp_font_family", 0, "not-content"],
      ["wp_font_face", 0, "not-content"],
    ]);
  });

  it("costs five requests: types, two collections, the index and its child", async () => {
    const deps = recordedFetcher();
    const result = await resolveTruthSource(site("403bplan.net"), deps);
    expect(deps.requested).toEqual([
      "https://403bplan.net/wp-json/wp/v2/types",
      `https://403bplan.net/wp-json/wp/v2/posts?${FIELDS}`,
      `https://403bplan.net/wp-json/wp/v2/pages?${FIELDS}`,
      "https://403bplan.net/sitemap_index.xml",
      "https://403bplan.net/page-sitemap.xml",
    ]);
    expect(result.requests).toBe(5);
  });
});

describe("resolveTruthSource: the cohorts with no inventory", () => {
  it("reports 'none' for a reachable host with neither source", async () => {
    const deps = recordedFetcher();
    const result = await resolveTruthSource(site("123.planenroll.com"), deps);
    expect(result.kind).toBe("none");
    expect(result.urls).toEqual([]);
    expect(result.counts).toEqual({ total: null, rest: null, sitemap: null });
    // All four paths were tried before concluding there is nothing.
    expect(deps.requested).toHaveLength(4);
  });

  /**
   * `agents.integrity.com` has no DNS and `integritymedicarehelpline.com` refuses
   * connections (PRD §3.1), and both hold live pw-template configs. "We could not ask"
   * is not "there is nothing": the first is a registry-health finding with a DNS fix,
   * the second means orphan detection is undetectable forever. Collapsing them into
   * `none` would file a dead host as a permanently unmonitorable one.
   */
  it("reports 'unreachable' for a host that never answers, not 'none'", async () => {
    const deps = recordedFetcher({ unreachable: ["agents.integrity.com"] });
    const result = await resolveTruthSource(site("agents.integrity.com"), deps);
    expect(result.kind).toBe("unreachable");
    expect(result.counts).toEqual({ total: null, rest: null, sitemap: null });
    // Two probes, then it stops: a host that is not answering will not answer a
    // different path, and the remaining candidates only add latency.
    expect(deps.requested).toEqual([
      "https://agents.integrity.com/wp-json/wp/v2/types",
      "https://agents.integrity.com/sitemap_index.xml",
    ]);
  });
});

/**
 * A planted shape: 403bplan.net's REST probe answers with the 404 recorded from
 * 123.planenroll.com while its real sitemap answers normally. **No estate host was
 * measured with this shape** — all seven WordPress hosts probed on 2026-08-20 serve
 * `/wp-json/wp/v2/types`, including every sitemapped one — so PRD §4's step 2 has no
 * live cohort member and this is the only way to cover it.
 */
describe("resolveTruthSource: sitemap only", () => {
  const restAbsent = {
    substitute: {
      "https://403bplan.net/wp-json/wp/v2/types":
        "https://123.planenroll.com/wp-json/wp/v2/types",
    },
  };

  it("falls through to the sitemap and leaves the REST count unknown", async () => {
    const result = await resolveTruthSource(
      site("403bplan.net"),
      recordedFetcher(restAbsent),
    );
    expect(result.kind).toBe("sitemap");
    expect(result.counts).toEqual({ total: 13, rest: null, sitemap: 13 });
    expect(result.urls.every((u) => u.inSitemap && !u.inRest)).toBe(true);
    // The child sitemap the URLs came out of is `page-sitemap.xml`, so the post type is
    // known even with no CMS to ask. Step 5 discarded that name and recorded null here.
    expect(result.urls.every((u) => u.postType === "page")).toBe(true);
    expect(result.postTypes).toEqual([]);
    // Nothing declares a taxonomy when REST cannot be read, and an empty vocabulary
    // excludes nothing — the direction that keeps a finding rather than hiding one.
    expect(result.taxonomies).toEqual([]);
  });
});

/**
 * A host that answers one probe and drops the other. Found by Gate 2: both halves used
 * to return silently, and the second one resolved a site to `none` — "we asked and there
 * is nothing" — because a request failed.
 */
describe("resolveTruthSource: one probe answers, the other does not", () => {
  it("records that the REST probe never answered, rather than resolving quietly", async () => {
    const deps = recordedFetcher({
      unreachable: ["https://403bplan.net/wp-json/wp/v2/types"],
    });
    const result = await resolveTruthSource(site("403bplan.net"), deps);
    // The sitemap is a real inventory, so the site does resolve — but the report says
    // the CMS was never read, which is the difference between "13 URLs, cross-checked"
    // and "13 URLs, and nobody looked at the other source".
    expect(result.kind).toBe("sitemap");
    expect(result.counts).toEqual({ total: 13, rest: null, sitemap: 13 });
    expect(result.findings.map((f) => f.kind)).toEqual(["rest-unusable"]);
    expect(result.findings[0]?.detail).toMatch(/ENOTFOUND/);
  });

  it("refuses rather than calling a site sourceless when its sitemap never answered", async () => {
    const deps = recordedFetcher({
      substitute: {
        "https://403bplan.net/wp-json/wp/v2/types":
          "https://123.planenroll.com/wp-json/wp/v2/types",
      },
      unreachable: ["https://403bplan.net/sitemap_index.xml"],
    });
    // REST 404s, which is a real answer; the sitemap probe drops the connection, which
    // is not. `none` would disable orphan detection for this site permanently.
    await expect(resolveTruthSource(site("403bplan.net"), deps)).rejects.toThrow(
      /could not be resolved: sitemap-incomplete.*ENOTFOUND/,
    );
  });
});

describe("enumerateRest: pagination, and a site that lies about its total", () => {
  const integrity = site("integrity.com");
  const pageType = postType("integrity.com", "page");

  it("paginates a real two-page collection and collects all 124", async () => {
    const deps = recordedFetcher();
    const out = await enumerateRest(integrity, [pageType], deps, 100);
    expect(out.kind).toBe("ok");
    expect(out.urls).toHaveLength(124);
    expect(out.findings).toEqual([]);
    expect(deps.requested).toEqual([
      `https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`,
      `https://integrity.com/wp-json/wp/v2/pages?${PAGE_2}`,
    ]);
  });

  /**
   * Both halves of "a site that lies about its total" are built from real responses.
   * Here the declared total is 476 (integrity.com's `blog`, planted as page 1) while
   * only 124 items arrive and the server says there is no next page.
   *
   * **This is the silent half, and it must not resolve.** Gate 2 found the first version
   * returning `kind: "ok"` with the short list and a finding beside it — after which 124
   * becomes `crawls.truth_source_urls`, a crawl of those 124 pages measures 100%
   * coverage, and the orphan set of a 476-page post type is published as complete. 352
   * pages that no report could ever mention.
   */
  it("refuses the short list when the declared total disagrees", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
      },
    });
    const out = await enumerateRest(integrity, [pageType], deps, 100);
    expect(out.kind).toBe("incomplete");
    expect(out.urls).toEqual([]);
    expect(out.findings.map((f) => f.kind)).toEqual(["rest-total-mismatch"]);
    expect(out.findings[0]?.detail).toBe(
      "page: X-WP-Total declared 476 but after 2 request(s), 124 URL(s) collected",
    );
  });

  /**
   * The same shape with the item count stripped instead of wrong: `X-WP-TotalPages` says
   * 5 and one request was enough, which is what a CDN dropping the `Link: rel="next"`
   * header looks like. Every host in this estate sits behind CloudFront, so the header
   * the pagination loop depends on crosses an intermediary that may not forward it.
   */
  it("refuses when the declared page count says there was more to fetch", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
      },
      stripHeaders: ["x-wp-total", "link"],
    });
    const out = await enumerateRest(integrity, [pageType], deps, 100);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.detail).toBe(
      "page: X-WP-TotalPages declared 5 but after 1 request(s), 100 URL(s) collected",
    );
  });

  /**
   * The other half: the collection declares five pages and the second request is the
   * real `400 rest_post_invalid_page_number`. A prefix of an inventory is not an
   * inventory, so REST stops being usable as the truth source.
   */
  it("refuses to return a prefix when pagination breaks partway", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
        [`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}&page=2`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}&page=6`,
      },
    });
    const out = await enumerateRest(integrity, [pageType], deps, 100);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.kind).toBe("rest-incomplete");
    expect(out.findings[0]?.detail).toMatch(/rest_post_invalid_page_number/);
  });

  it("records a post type it is not allowed to read, rather than reading zero", async () => {
    // nav_menu_item is skipped as non-content before any request; asking for it anyway
    // is how the 401 path is exercised with a real 401 (measured on menu-items).
    const deps = recordedFetcher({
      substitute: {
        [`https://integrity.com/wp-json/wp/v2/menu-items?${FIELDS}`]:
          "https://integrity.com/wp-json/wp/v2/menu-items?per_page=1",
      },
    });
    const out = await enumerateRest(
      integrity,
      [postType("integrity.com", "nav_menu_item")],
      deps,
      100,
    );
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.kind).toBe("rest-incomplete");
    expect(out.findings[0]?.detail).toMatch(/401/);
  });

  /**
   * The shape with no continuation signal left at all: no `Link`, no `X-WP-Total`, no
   * `X-WP-TotalPages`. Gate 2 round 2 found this passing as `ok` with 100 of 476 URLs
   * and **no finding whatsoever** — the quietest version of the failure this file is
   * about. A page that is exactly full and says nothing about a next page is not the end
   * of a collection.
   */
  it("refuses a full page with nothing at all to corroborate the end", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://integrity.com/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
      },
      stripHeaders: ["x-wp-total", "x-wp-totalpages", "link"],
    });
    const out = await enumerateRest(integrity, [pageType], deps, 100);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.detail).toMatch(/nothing corroborates/);
  });

  it("stops on the request budget rather than truncating quietly", async () => {
    const deps = recordedFetcher();
    const out = await enumerateRest(integrity, [pageType], deps, 1);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.detail).toMatch(/budget/);
  });

  it("treats an inventory of nothing as no inventory (guide §1)", async () => {
    const out = await enumerateRest(
      site("403bplan.net"),
      [postType("403bplan.net", "post")],
      recordedFetcher(),
      100,
    );
    // 403bplan.net really has zero posts. A truth source of [] is not an answer.
    expect(out.kind).toBe("absent");
  });
});

/**
 * The rule that decides whether a finished enumeration can be trusted, over the four
 * shapes a WordPress collection actually produces. `X-WP-Total` and `X-WP-TotalPages`
 * both cross an intermediary — every host in this estate is behind CloudFront — so any
 * combination of them can be missing.
 */
describe("paginationShortfall", () => {
  const shortfall = (
    declaredTotal: number | null,
    declaredPages: number | null,
    collected: number,
    pages: number,
  ) => paginationShortfall("page", declaredTotal, declaredPages, collected, pages);

  it("accepts an enumeration the headers agree with", () => {
    expect(shortfall(124, 2, 124, 2)).toBeNull();
    expect(shortfall(13, 1, 13, 1)).toBeNull();
    // A legitimately empty post type: 403bplan.net has no posts.
    expect(shortfall(0, 0, 0, 1)).toBeNull();
    // A short last page is how every collection that is not an exact multiple ends.
    expect(shortfall(124, null, 124, 2)).toBeNull();
  });

  it("refuses when either header says there was more to fetch", () => {
    expect(shortfall(476, 5, 124, 2)).toMatch(/X-WP-Total declared 476/);
    expect(shortfall(null, 5, 100, 1)).toMatch(/X-WP-TotalPages declared 5/);
  });

  /**
   * Collecting MORE than declared is a superset of the inventory — something published
   * while pagination ran — and a superset cannot hide an orphan. Refusing it would make
   * agent.familyfirstlife.com, 594 requests and ten minutes of enumeration, unresolvable
   * whenever anyone published a page.
   */
  it("accepts collecting more than the declared total", () => {
    expect(shortfall(476, 5, 477, 5)).toBeNull();
  });

  it("refuses a page that is exactly full with nothing to corroborate the end", () => {
    // No Link header, no totals: the shape of an intermediary stripping all three.
    expect(shortfall(null, null, 100, 1)).toMatch(/nothing corroborates/);
    expect(shortfall(null, null, 200, 2)).toMatch(/nothing corroborates/);
    // A page that is not full ends a collection on its own evidence.
    expect(shortfall(null, null, 87, 1)).toBeNull();
  });
});

describe("readSitemapResponse: status is recorded, content decides", () => {
  /**
   * **Measured, and the sharpest §1 case in the estate:**
   * `agent.familyfirstlife.com/wp-sitemap-posts-page-30.xml` answers **404** with a
   * valid 161 KB `<urlset>` holding 1,362 real URLs — REST confirms every one of them
   * exists. A resolver that trusted the status code would silently drop them; one that
   * ignored the status would never report the anomaly.
   */
  it("uses a 404 whose body is a real sitemap, and records the status", () => {
    const res = readSitemapResponse(
      recordedResponse("https://agent.familyfirstlife.com/wp-sitemap-posts-page-30.xml"),
    );
    expect(res).toMatchObject({ kind: "sitemap", degraded: "HTTP 404" });
    expect(res.kind === "sitemap" && res.doc.locs).toHaveLength(1362);
  });

  it("reports a redirect as a redirect, so a cross-host hop cannot pass unnoticed", () => {
    // Measured: /sitemap.xml 301s to /wp-sitemap.xml on this host, which is why the
    // census reached a WP-core sitemap while recording "via: sitemap.xml".
    expect(
      readSitemapResponse(
        recordedResponse("https://agent.familyfirstlife.com/sitemap.xml"),
      ),
    ).toEqual({
      kind: "redirect",
      location: "https://agent.familyfirstlife.com/wp-sitemap.xml",
    });
  });

  it("reports an HTML 404 as not a sitemap", () => {
    expect(
      readSitemapResponse(recordedResponse("https://123.planenroll.com/sitemap.xml"))
        .kind,
    ).toBe("not-a-sitemap");
  });

  it("reports a 200 that is not a sitemap as not a sitemap", () => {
    expect(
      readSitemapResponse({ status: 200, headers: {}, body: "<html></html>" }).kind,
    ).toBe("not-a-sitemap");
  });
});

describe("enumerateSitemap", () => {
  it("follows the index to its children (403bplan.net)", async () => {
    const deps = recordedFetcher();
    const out = await enumerateSitemap(site("403bplan.net"), deps, 100);
    expect(out.kind).toBe("ok");
    expect(out.urls).toHaveLength(13);
    expect(out.findings).toEqual([]);
  });

  /**
   * A sitemap that redirects off-site. Real responses on both sides: 403bplan.net's
   * `/sitemap_index.xml` answers with `agent.familyfirstlife.com/sitemap.xml`'s recorded
   * 301, whose `Location` is on that other host. Following it would put another site's
   * 59,362 URLs into this site's inventory.
   */
  it("refuses a sitemap that redirects to another host", async () => {
    const deps = recordedFetcher({
      substitute: {
        "https://403bplan.net/sitemap_index.xml":
          "https://agent.familyfirstlife.com/sitemap.xml",
        "https://403bplan.net/sitemap.xml": "https://123.planenroll.com/sitemap.xml",
        "https://403bplan.net/wp-sitemap.xml":
          "https://123.planenroll.com/wp-sitemap.xml",
      },
    });
    const out = await enumerateSitemap(site("403bplan.net"), deps, 100);
    // The remaining candidates are still tried — a refusal on one path is not an answer
    // about the others — and the refusal is what the outcome reports.
    expect(deps.requested).toHaveLength(3);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.detail).toMatch(/redirects off-site to/);
  });

  /**
   * A path-level refusal on the first candidate, and the third one answers. Both
   * responses are real: integrity.com's `menu-items` 401 (JSON, so not a sitemap) stands
   * in for a Wordfence challenge on `/sitemap_index.xml`, and 403bplan.net's own
   * `page-sitemap.xml` answers at `/wp-sitemap.xml`, which is where WP core puts it.
   */
  it("tries the remaining candidates after one refuses, and records the refusal", async () => {
    const deps = recordedFetcher({
      substitute: {
        "https://403bplan.net/sitemap_index.xml":
          "https://integrity.com/wp-json/wp/v2/menu-items?per_page=1",
        "https://403bplan.net/sitemap.xml": "https://123.planenroll.com/sitemap.xml",
        "https://403bplan.net/wp-sitemap.xml": "https://403bplan.net/page-sitemap.xml",
      },
    });
    const out = await enumerateSitemap(site("403bplan.net"), deps, 100);
    expect(out.kind).toBe("ok");
    expect(out.urls).toHaveLength(13);
    // The 401 is still reported, even though the inventory came back whole.
    expect(out.findings.map((f) => f.kind)).toEqual(["sitemap-degraded"]);
    expect(out.findings[0]?.detail).toMatch(/HTTP 401/);
  });

  it("refuses to return part of a sitemap when a child cannot be read", async () => {
    const deps = recordedFetcher({
      substitute: {
        "https://403bplan.net/page-sitemap.xml": "https://123.planenroll.com/sitemap.xml",
      },
    });
    const out = await enumerateSitemap(site("403bplan.net"), deps, 100);
    expect(out.kind).toBe("incomplete");
    expect(out.findings[0]?.kind).toBe("sitemap-incomplete");
  });
});

/**
 * A source whose URLs are all somebody else's. The plant serves integrity.com's real
 * `page-sitemap.xml` — 96 URLs, none of them on 403bplan.net — as 403bplan.net's child
 * sitemap. Every URL is dropped as foreign, and the danger is what is left: a sitemap
 * count of **0**, which would make `sitemap-invisible` report all 13 REST URLs as
 * missing from a sitemap that in fact listed nothing we could use. Zero is not a count
 * here, it is an absence.
 */
describe("resolveTruthSource: a source that lists nothing usable", () => {
  it("treats a source with no usable URL as absent, not as a count of zero", async () => {
    const deps = recordedFetcher({
      substitute: {
        "https://403bplan.net/page-sitemap.xml": "https://integrity.com/page-sitemap.xml",
      },
    });
    const result = await resolveTruthSource(site("403bplan.net"), deps);
    expect(result.kind).toBe("rest");
    expect(result.counts).toEqual({ total: 13, rest: 13, sitemap: null });
    // No sitemap count, so no cross-check finding either — and in particular not
    // "13 URLs are missing from the sitemap".
    // "96 URLs, none of them ours" is not "there is no sitemap": it is a sitemap we
    // could not use, which is why the finding is `sitemap-incomplete`.
    expect(result.findings.map((f) => f.kind)).toEqual([
      "dropped-url",
      "sitemap-incomplete",
    ]);
  });
});

/**
 * Neither source can be trusted and there is nothing to fall back to. The only honest
 * outcomes are a resolution or an exception — never `none`, which claims we looked and
 * there is nothing to find.
 */
describe("resolveTruthSource refuses rather than resolving to 'none'", () => {
  it("throws when REST breaks partway and there is no sitemap", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://403bplan.net/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
        [`https://403bplan.net/wp-json/wp/v2/pages?${FIELDS}&page=2`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}&page=6`,
        "https://403bplan.net/sitemap_index.xml":
          "https://123.planenroll.com/sitemap_index.xml",
        "https://403bplan.net/sitemap.xml": "https://123.planenroll.com/sitemap.xml",
        "https://403bplan.net/wp-sitemap.xml":
          "https://123.planenroll.com/wp-sitemap.xml",
      },
    });
    await expect(resolveTruthSource(site("403bplan.net"), deps)).rejects.toThrow(
      /could not be resolved: rest-incomplete.*rest_post_invalid_page_number/,
    );
  });

  it("throws a typed error that carries the unresolved findings", async () => {
    const deps = recordedFetcher({
      substitute: {
        [`https://403bplan.net/wp-json/wp/v2/pages?${FIELDS}`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}`,
        [`https://403bplan.net/wp-json/wp/v2/pages?${FIELDS}&page=2`]: `https://integrity.com/wp-json/wp/v2/blog?${FIELDS}&page=6`,
        "https://403bplan.net/sitemap_index.xml":
          "https://123.planenroll.com/sitemap_index.xml",
        "https://403bplan.net/sitemap.xml": "https://123.planenroll.com/sitemap.xml",
        "https://403bplan.net/wp-sitemap.xml":
          "https://123.planenroll.com/wp-sitemap.xml",
      },
    });
    const error = await resolveTruthSource(site("403bplan.net"), deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TruthSourceUnresolvedError);
    expect((error as TruthSourceUnresolvedError).findings[0]?.kind).toBe(
      "rest-incomplete",
    );
  });
});

/**
 * The two sites PRD §2 and §4 measured, cross-checked from their recorded
 * `/wp/v2/types` and sitemap index. Neither can be resolved end to end from fixtures —
 * integrity.com is 34 responses and tidewatermg.com's children were never recorded — but
 * the two documents that decide the Excluded class both are, and this is the arithmetic
 * PRD §4 states.
 */
describe("the sitemap index, split by the site's own vocabulary", () => {
  const split = (host: string) => {
    const taxonomies = new Set(declaredTaxonomies(types(host)));
    const locs = parseSitemap(recordedBody(`https://${host}/sitemap_index.xml`))?.locs;
    const names = (locs ?? []).map((loc) => sitemapChild(loc) ?? loc);
    return {
      taxonomy: names.filter((name) => taxonomies.has(name)),
      other: names.filter((name) => !taxonomies.has(name)),
    };
  };

  /**
   * PRD §4: "tidewatermg.com's 15 content post types … and the 18 taxonomy and author
   * children". 17 taxonomy children plus `author` is that 18, and `bricks_template` is
   * §4's page-builder artifact — the one child with a sitemap and no REST type at all.
   */
  it("finds tidewatermg.com's 17 taxonomy children, its author archive and bricks", () => {
    const { taxonomy, other } = split("tidewatermg.com");
    expect(taxonomy).toHaveLength(17);
    expect(other).toHaveLength(17);
    // Everything the vocabulary cannot name, named: 15 content post types, plus these.
    expect(
      other.filter((name) => name === "author" || name === "bricks_template"),
    ).toEqual(["bricks_template", "author"]);
  });

  /**
   * The nine orphans the 2026-08-25 integrity.com run reported were terms of four of
   * these five taxonomies (`category`, `family_category`, `insights_category`,
   * `wealth_category`); the fifth, `teammember_level`, had none in the orphan list.
   */
  it("finds integrity.com's five taxonomy children among fourteen", () => {
    const { taxonomy, other } = split("integrity.com");
    expect(taxonomy).toEqual([
      "category",
      "teammember_level",
      "family_category",
      "wealth_category",
      "insights_category",
    ]);
    expect(other).toHaveLength(9);
  });
});
