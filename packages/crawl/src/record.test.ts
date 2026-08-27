/**
 * The response to rows rules, against the real 403bplan.net captures.
 *
 * The bodies are production responses checked in for step 4
 * (`packages/analyse/test/fixtures/403bplan-net/`, captured 2026-08-20 at 1 req/s);
 * every header value used here is one measured on this estate and cited where it is
 * used. Nothing is invented: a test that proves `noindex` handling against a header
 * nobody has seen proves only that the code matches the test.
 */
import { describe, expect, it } from "vitest";
import { normalizeUrl, type NormalizedUrl, type SiteHosts } from "@link-graph/core";
import { headerNoindex, isHtmlContentType, recordPage } from "./record.js";
import type { RecordInput } from "./record.js";
import { capture as html } from "./testing/403bplan.js";

const site: SiteHosts = {
  canonicalHost: "403bplan.net",
  aliases: ["403bplan.net", "www.403bplan.net"],
};

const url = (href: string): NormalizedUrl => {
  const parsed = normalizeUrl(href, site);
  if (parsed === null) throw new Error(`not a URL: ${href}`);
  return parsed;
};

/** A 200 text/html response, which is what 13 of the 13 sitemap URLs returned. */
const served = (input: Partial<RecordInput> & { url: NormalizedUrl }): RecordInput => ({
  inTruthSource: true,
  postType: null,
  site,
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8" },
  body: "",
  redirectTo: null,
  ...input,
});

describe("isHtmlContentType", () => {
  it("accepts what the estate serves", () => {
    // Measured 2026-08-24 on 403bplan.net/terms-of-service/: `text/html; charset=UTF-8`.
    expect(isHtmlContentType("text/html; charset=UTF-8")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    for (const value of [
      undefined,
      "",
      "application/pdf",
      "application/json",
      "text/xml",
    ]) {
      expect([value, isHtmlContentType(value)]).toEqual([value, false]);
    }
  });
});

describe("headerNoindex", () => {
  it("reads the measured X-Robots-Tag on this estate", () => {
    // PRD 5.1, measured 2026-08-20: 403bplan.net/wp-json/ answers 200 with
    // `x-robots-tag: noindex`. `extractPage` cannot see a response header, which is why
    // step 2 handed this to the crawler.
    expect(headerNoindex("noindex")).toBe(true);
  });

  it("reads the other directives that mean the same thing", () => {
    expect(headerNoindex("noindex, nofollow")).toBe(true);
    expect(headerNoindex("none")).toBe(true);
    expect(headerNoindex("NoIndex")).toBe(true);
    // A per-crawler directive still states the intent, and intent is what PRD 2's
    // Excluded class is about.
    expect(headerNoindex("googlebot: noindex")).toBe(true);
    // undici joins a repeated header with ", ".
    expect(headerNoindex("nosnippet, googlebot: noindex")).toBe(true);
    // Whitespace-separated, as `extractPage` reads the meta tag. The header syntax says
    // commas, but a site that writes it this way means the same thing, and core already
    // honours the form — the two must not disagree about `indexable`.
    expect(headerNoindex("noindex nofollow")).toBe(true);
  });

  it("does not read an absent or unrelated header as noindex", () => {
    const values = [
      undefined,
      "",
      "nofollow",
      "noarchive",
      "index, follow",
      "noindexing",
    ];
    for (const value of values) {
      expect([value, headerNoindex(value)]).toEqual([value, false]);
    }
  });
});

describe("recordPage", () => {
  /**
   * The truth source knew the post type of every inventory URL and step 6 threw it
   * away, which left `pages.post_type` NULL for all 2,454 rows of the integrity.com
   * crawl and PRD §2's Excluded classes with nothing to read. The frontier carries it
   * now, because on a resumed crawl the seed list is gone with the process that held it.
   */
  it("records the post type the frontier carried for this URL", () => {
    const record = recordPage(
      served({
        url: url("https://403bplan.net/newsletters/"),
        postType: "page",
        body: html("newsletters.html"),
      }),
    );
    expect(record.page.postType).toBe("page");
    // And the other direction: nothing named a post type for a discovered URL, and
    // `null` must survive as "unknown" rather than acquiring a default.
    expect(
      recordPage(
        served({
          url: url("https://403bplan.net/newsletters/"),
          body: html("newsletters.html"),
        }),
      ).page.postType,
    ).toBeNull();
  });

  it("records a served page and its links", () => {
    const record = recordPage(
      served({ url: url("https://403bplan.net/"), body: html("home.html") }),
    );
    expect(record.page).toEqual({
      urlNormalized: "https://403bplan.net/",
      path: "/",
      postType: null,
      statusCode: 200,
      depth: null,
      inTruthSource: true,
      indexable: true,
      canonicalTo: "https://403bplan.net/",
      redirectTo: null,
      class: null,
    });
    // 17, the count step 2 derived from the markup without cheerio.
    expect(record.links).toHaveLength(17);
    const first = record.links[0];
    // 1, not 0: `domIndex` is the position in the page's whole `<a href>` sequence
    // including the anchors extraction skips, and this page opens with a `#` skip
    // link. Keeping the gaps is what makes the position stable.
    expect(first?.domIndex).toBe(1);
    expect(first?.container).toBe("header");
    // Never false: `analyse` computes it, and a default would make an un-analysed
    // crawl look analysed (002_crawls.sql).
    expect(record.links.every((l) => l.isBoilerplate === null)).toBe(true);
    expect(record.links.filter((l) => l.isExternal)).toHaveLength(7);
  });

  it("keeps every DOM position, so 24 links to one target stay 24 edges", () => {
    // Step 3 measured tidewatermg.com linking one Google reviews URL 24 times from 24
    // positions, and `links` has UNIQUE (crawl_id, from_page_id, dom_index): two edges
    // sharing a position would be a rejected INSERT, not a lost row. So what matters
    // is that the positions are distinct and increasing, not that they are dense.
    const record = recordPage(
      served({ url: url("https://403bplan.net/"), body: html("home.html") }),
    );
    const positions = record.links.map((l) => l.domIndex);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("offers only crawlable internal targets to the frontier", () => {
    const record = recordPage(
      served({
        url: url("https://403bplan.net/plan-participant/fund-prospectuses/"),
        body: html("plan-participant__fund-prospectuses.html"),
      }),
    );
    // The page links PDFs; the crawlable targets are the site's own pages only, and
    // never itself.
    expect(record.links.some((l) => l.toUrlNormalized.endsWith(".pdf"))).toBe(true);
    expect(record.discovered.some((u) => u.endsWith(".pdf"))).toBe(false);
    expect(record.discovered).not.toContain(
      "https://403bplan.net/plan-participant/fund-prospectuses/",
    );
    expect(record.discovered.every((u) => u.startsWith("https://403bplan.net/"))).toBe(
      true,
    );
    // Deduplicated: the nav repeats every target on every page.
    expect(new Set(record.discovered).size).toBe(record.discovered.length);
  });

  it("records the canonical of a canonicalized duplicate", () => {
    // Real: the capture was fetched with `?ref=lgtest` and Yoast's canonical points at
    // the clean permalink. PRD 2 calls that Excluded, and `analyse` needs the target.
    const record = recordPage(
      served({
        url: url("https://403bplan.net/newsletter-signup/?ref=lgtest"),
        inTruthSource: false,
        body: html("newsletter-signup.html"),
      }),
    );
    expect(record.page.canonicalTo).toBe("https://403bplan.net/newsletter-signup/");
    expect(record.page.urlNormalized).toBe(
      "https://403bplan.net/newsletter-signup/?ref=lgtest",
    );
  });

  it("marks a page noindex from the response header alone", () => {
    // The body says nothing about robots; the header is the whole signal, and without
    // this the page would be orphan-eligible (PRD 5.1).
    const record = recordPage(
      served({
        url: url("https://403bplan.net/"),
        body: html("home.html"),
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "x-robots-tag": "noindex",
        },
      }),
    );
    expect(record.page.indexable).toBe(false);
  });

  it("marks a page noindex from the body alone", () => {
    // Real: Yoast serves `noindex, follow` on 403bplan.net/?s=403b.
    const record = recordPage(
      served({
        url: url("https://403bplan.net/?s=403b"),
        inTruthSource: false,
        body: html("search-403b.html"),
      }),
    );
    expect(record.page.indexable).toBe(false);
  });

  it("does not parse a body the server did not serve as HTML", () => {
    // Anything else is a guess about a format we have no parser for, and the links it
    // "found" would be edges nobody wrote.
    const record = recordPage(
      served({
        url: url("https://403bplan.net/brochure/"),
        headers: { "content-type": "application/pdf" },
        body: html("home.html"),
      }),
    );
    expect(record.links).toEqual([]);
    expect(record.discovered).toEqual([]);
    expect(record.page.statusCode).toBe(200);
  });

  it("does not parse an error page's body", () => {
    // A WordPress 404 serves the whole nav. Parsing it would credit the missing page
    // with the site's entire menu as outbound edges, and every nav target with one
    // more inbound edge from a page that does not exist.
    const record = recordPage(
      served({
        url: url("https://403bplan.net/gone/"),
        status: 404,
        body: html("home.html"),
      }),
    );
    expect(record.page.statusCode).toBe(404);
    expect(record.links).toEqual([]);
    expect(record.discovered).toEqual([]);
  });

  it("records a redirect as a redirect and never as a page with links", () => {
    const record = recordPage(
      served({
        url: url("https://403bplan.net/old-page/"),
        status: 301,
        body: "",
        redirectTo: "https://403bplan.net/contact-us/",
      }),
    );
    expect(record.page.statusCode).toBe(301);
    expect(record.page.redirectTo).toBe("https://403bplan.net/contact-us/");
    expect(record.links).toEqual([]);
    // The target is still a page this crawl must fetch: PRD 2's "reachable only
    // through a redirect" case needs a row for it.
    expect(record.discovered).toEqual(["https://403bplan.net/contact-us/"]);
  });

  it("refuses a 200 text/html response with an empty body", () => {
    // `extractPage` refuses this too, for the same reason: zero links from a page that
    // served nothing reads downstream as a page nobody links out of.
    expect(() =>
      recordPage(served({ url: url("https://403bplan.net/"), body: "" })),
    ).toThrow(/empty/i);
  });

  it("refuses a body the server compressed, rather than parsing zero links out of it", () => {
    // The fetcher asks for `identity` (measured 2026-08-24: 403bplan.net honours it).
    // A server that compresses anyway hands cheerio binary, which yields no links and
    // therefore a page that looks like a leaf: engineering guide 1.
    expect(() =>
      recordPage(
        served({
          url: url("https://403bplan.net/"),
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
          body: "not really gzip, but the header says it is",
        }),
      ),
    ).toThrow(/content-encoding/i);
  });
});
